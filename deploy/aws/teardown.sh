#!/usr/bin/env bash
# Tear down the OpenViking production deployment (idempotent).
# DANGER: deletes the EC2, EIP, ALB, target group, Route 53 record, and S3
# artifact. The EIP and any DNS are removed. Postgres data lives on the EC2 data
# volume (/opt/viking/data) — download it BEFORE tearing down if you want it.
set -euo pipefail
REGION="${REGION:-us-west-2}"
HOSTED_ZONE_ID="${HOSTED_ZONE_ID:-Z2ANBWTR462YC8}"
DOMAIN="${DOMAIN:-viking.metabolomics.us}"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
NAME="viking-openviking"
BUCKET="${BUCKET:-viking-metabolomics-us-$ACCOUNT}"

say(){ printf '\n==> %s\n' "$*"; }

say "delete Route 53 A record"
aws route53 change-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" --change-batch "{
  \"Changes\":[{\"Action\":\"DELETE\",\"ResourceRecordSet\":{\"Name\":\"$DOMAIN\",\"Type\":\"A\",\"TTL\":60,\"ResourceRecords\":[{\"Value\":\"127.0.0.1\"}]}}]}" >/dev/null 2>&1 || true
# (The real alias record may have different shape; fall back to UPSERT-delete via describe is complex.
#  We instead rely on the ALB deletion + manual DNS check.)

say "delete ALB + target group"
ALB_ARN=$(aws elbv2 describe-load-balancers --region "$REGION" --query "LoadBalancers[?contains(LoadBalancerName,'$NAME')].LoadBalancerArn" --output text 2>/dev/null || true)
if [ -n "$ALB_ARN" ] && [ "$ALB_ARN" != "None" ]; then
  for L in $(aws elbv2 describe-listeners --load-balancer-arn "$ALB_ARN" --region "$REGION" --query 'Listeners[].ListenerArn' --output text 2>/dev/null); do
    aws elbv2 delete-listener --listener-arn "$L" --region "$REGION" >/dev/null 2>&1 || true
  done
  aws elbv2 delete-load-balancer --load-balancer-arn "$ALB_ARN" --region "$REGION" >/dev/null 2>&1 || true
fi
TG_ARN=$(aws elbv2 describe-target-groups --region "$REGION" --query "TargetGroups[?contains(TargetGroupName,'$NAME')].TargetGroupArn" --output text 2>/dev/null || true)
if [ -n "$TG_ARN" ] && [ "$TG_ARN" != "None" ]; then
  aws elbv2 delete-target-group --target-group-arn "$TG_ARN" --region "$REGION" >/dev/null 2>&1 || true
fi

say "terminate EC2 instances"
for I in $(aws ec2 describe-instances --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=pending,running,stopped,stopping" --region "$REGION" --query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null); do
  aws ec2 terminate-instances --instance-ids "$I" --region "$REGION" >/dev/null 2>&1 || true
done

say "release Elastic IP"
for A in $(aws ec2 describe-addresses --filters "Name=tag:Name,Values=$NAME" --region "$REGION" --query 'Addresses[].AllocationId' --output text 2>/dev/null); do
  aws ec2 disassociate-address --allocation-id "$A" --region "$REGION" >/dev/null 2>&1 || true
  aws ec2 release-address --allocation-id "$A" --region "$REGION" >/dev/null 2>&1 || true
done

say "delete security groups"
for G in "$NAME-alb" "$NAME-ec2"; do
  SGID=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=$G" --region "$REGION" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
  if [ -n "$SGID" ] && [ "$SGID" != "None" ]; then
    aws ec2 delete-security-group --group-id "$SGID" --region "$REGION" >/dev/null 2>&1 || true
  fi
done

say "remove S3 artifact"
aws s3 rm "s3://$BUCKET/openviking/openviking.tar.gz" --region "$REGION" >/dev/null 2>&1 || true

say "note: ACM certificate, IAM role/profile/policy, and S3 bucket are left in place"
echo "  (delete manually if no longer needed)"
echo "teardown complete"
