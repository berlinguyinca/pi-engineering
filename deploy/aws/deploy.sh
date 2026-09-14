#!/usr/bin/env bash
# Provision the OpenViking production deployment on AWS:
#
#   EC2 (docker compose, data volume at /opt/viking/data with secrets/)  <- service
#   ALB + ACM cert  (TLS terminated at the load balancer)                 <- front
#   Elastic IP      (stable SSH address for the box)                      <- ssh
#   Route 53 record viking.metabolomics.us -> ALB                        <- DNS
#
# Idempotent: safe to re-run; it finds existing resources by Name tag and only
# creates what is missing. Requires an authenticated AWS CLI with admin access.
#
# Usage:  ./deploy/aws/deploy.sh
# Env overrides (defaults in CAPS at top): REGION, HOSTED_ZONE_ID, DOMAIN,
#   VPC_ID, SUBNET_ID, KEY_NAME, AMI, INSTANCE_TYPE, SSH_CIDR, BUCKET.
set -euo pipefail

# ---- configuration (override via env) ------------------------------------
REGION="${REGION:-us-west-2}"
HOSTED_ZONE_ID="${HOSTED_ZONE_ID:-Z2ANBWTR462YC8}"   # metabolomics.us
DOMAIN="${DOMAIN:-viking.metabolomics.us}"
VPC_ID="${VPC_ID:-vpc-1f8ec666}"
SUBNET_ID="${SUBNET_ID:-subnet-e382339a}"            # us-west-2a public
KEY_NAME="${KEY_NAME:-wohlgemuth}"
AMI="${AMI:-ami-04678417fc39d7171}"                  # Ubuntu 24.04 amd64
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.small}"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
BUCKET="${BUCKET:-viking-metabolomics-us-$ACCOUNT}"
NAME="viking-openviking"
TAG="Name=$NAME"

# SSH source CIDR for the box (default: the caller's current public IP).
if [ -z "${SSH_CIDR:-}" ]; then
  MY_IP=$(curl -s -m 10 https://checkip.amazonaws.com || true)
  SSH_CIDR="${MY_IP:+$MY_IP/32}"
fi
[ -n "$SSH_CIDR" ] || { echo "could not determine SSH_CIDR; set SSH_CIDR=x.x.x.x/32"; exit 1; }

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SERVICE_DIR="$REPO_ROOT/services/openviking"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
have() { aws "$@" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
say "upload app to S3 ($BUCKET)"
if ! aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null 2>&1; then
  aws s3 mb "s3://$BUCKET" --region "$REGION"
fi
(cd "$SERVICE_DIR" && tar -czf /tmp/openviking.tar.gz .)
aws s3 cp /tmp/openviking.tar.gz "s3://$BUCKET/openviking/openviking.tar.gz" --region "$REGION"

# ---------------------------------------------------------------------------
say "IAM role + instance profile for S3 reads"
ROLE="$NAME-ec2"
POLICY="$NAME-s3"
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document '{
    "Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
fi
if ! aws iam get-policy --policy-arn "arn:aws:iam::$ACCOUNT:policy/$POLICY" >/dev/null 2>&1; then
  aws iam create-policy --policy-name "$POLICY" --policy-document "{
    \"Version\":\"2012-10-17\",
    \"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\"],\"Resource\":\"arn:aws:s3:::$BUCKET/openviking/*\"}]}"
fi
aws iam attach-role-policy --role-name "$ROLE" --policy-arn "arn:aws:iam::$ACCOUNT:policy/$POLICY" >/dev/null 2>&1 || true
if ! aws iam get-instance-profile --instance-profile-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-instance-profile --instance-profile-name "$ROLE"
fi
aws iam add-role-to-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE" >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
say "security groups"
SG_ALB=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=$NAME-alb" --region "$REGION" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
if [ -z "$SG_ALB" ] || [ "$SG_ALB" = "None" ]; then
  SG_ALB=$(aws ec2 create-security-group --group-name "$NAME-alb" --description "OpenViking ALB" --vpc-id "$VPC_ID" --region "$REGION" --query GroupId --output text)
fi
aws ec2 authorize-security-group-ingress --group-id "$SG_ALB" --protocol tcp --port 443 --cidr 0.0.0.0/0 --region "$REGION" >/dev/null 2>&1 || true
aws ec2 authorize-security-group-ingress --group-id "$SG_ALB" --protocol tcp --port 80  --cidr 0.0.0.0/0 --region "$REGION" >/dev/null 2>&1 || true

SG_EC2=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=$NAME-ec2" --region "$REGION" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
if [ -z "$SG_EC2" ] || [ "$SG_EC2" = "None" ]; then
  SG_EC2=$(aws ec2 create-security-group --group-name "$NAME-ec2" --description "OpenViking EC2" --vpc-id "$VPC_ID" --region "$REGION" --query GroupId --output text)
fi
aws ec2 authorize-security-group-ingress --group-id "$SG_EC2" --protocol tcp --port 22  --cidr "$SSH_CIDR" --region "$REGION" >/dev/null 2>&1 || true
# allow 8080 only from the ALB
aws ec2 authorize-security-group-ingress --group-id "$SG_EC2" --protocol tcp --port 8080 --source-group "$SG_ALB" --region "$REGION" >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
say "build user-data and launch EC2"
sed -e "s|__BUCKET__|$BUCKET|g" -e "s|__REGION__|$REGION|g" "$REPO_ROOT/deploy/aws/user-data.sh" > /tmp/openviking-user-data.sh
INSTANCE_ID=$(aws ec2 describe-instances --filters "Name=tag:$TAG" "Name=instance-state-name,Values=pending,running" --region "$REGION" --query 'Reservations[].Instances[0].InstanceId' --output text 2>/dev/null || true)
if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" = "None" ]; then
  INSTANCE_ID=$(aws ec2 run-instances \
    --image-id "$AMI" --instance-type "$INSTANCE_TYPE" --key-name "$KEY_NAME" \
    --subnet-id "$SUBNET_ID" --security-group-ids "$SG_EC2" \
    --iam-instance-profile "Name=$ROLE" --associate-public-ip-address \
    --user-data file:///tmp/openviking-user-data.sh \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME},{Key=Role,Value=openviking}]" \
    --region "$REGION" --query 'Instances[0].InstanceId' --output text)
  echo "    launched $INSTANCE_ID"
else
  echo "    reusing running instance $INSTANCE_ID"
fi

# ---------------------------------------------------------------------------
say "Elastic IP + associate (stable SSH address)"
EIP_ALLOC=$(aws ec2 describe-addresses --filters "Name=tag:Name,Values=$NAME" --region "$REGION" --query 'Addresses[0].AllocationId' --output text 2>/dev/null || true)
if [ -z "$EIP_ALLOC" ] || [ "$EIP_ALLOC" = "None" ]; then
  EIP_ALLOC=$(aws ec2 allocate-address --domain vpc --region "$REGION" --query AllocationId --output text)
  aws ec2 create-tags --resources "$EIP_ALLOC" --tags "Key=Name,Value=$NAME" --region "$REGION"
fi
aws ec2 associate-address --allocation-id "$EIP_ALLOC" --instance-id "$INSTANCE_ID" --region "$REGION" >/dev/null 2>&1 || true
EIP=$(aws ec2 describe-addresses --allocation-ids "$EIP_ALLOC" --region "$REGION" --query 'Addresses[0].PublicIp' --output text)
echo "    EIP = $EIP"

# ---------------------------------------------------------------------------
say "ACM certificate for $DOMAIN (DNS validation)"
CERT_ARN=$(aws acm list-certificates --region "$REGION" --query "CertificateSummaryList[?DomainName=='$DOMAIN'].CertificateArn" --output text 2>/dev/null || true)
if [ -z "$CERT_ARN" ] || [ "$CERT_ARN" = "None" ]; then
  CERT_ARN=$(aws acm request-certificate --domain-name "$DOMAIN" --validation-method DNS --region "$REGION" --query CertificateArn --output text)
fi
# create DNS validation records (idempotent)
for rec in $(aws acm describe-certificate --certificate-arn "$CERT_ARN" --region "$REGION" --query 'Certificate.DomainValidationOptions[].ResourceRecord' --output json | jq -c '.[]'); do
  RNAME=$(echo "$rec" | jq -r .Name)
  RVALUE=$(echo "$rec" | jq -r .Value)
  aws route53 change-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" --change-batch "{
    \"Changes\":[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{
      \"Name\":\"$RNAME\",\"Type\":\"CNAME\",\"TTL\":300,\"ResourceRecords\":[{\"Value\":\"$RVALUE\"}]}}]}" >/dev/null 2>&1 || true
done

# ---------------------------------------------------------------------------
say "ALB + target group + listeners"
ALB_ARN=$(aws elbv2 describe-load-balancers --region "$REGION" --query "LoadBalancers[?contains(LoadBalancerName,'$NAME')].LoadBalancerArn" --output text 2>/dev/null || true)
if [ -z "$ALB_ARN" ] || [ "$ALB_ARN" = "None" ]; then
  ALB_ARN=$(aws elbv2 create-load-balancer --name "$NAME" --subnets "$SUBNET_ID" \
    --security-groups "$SG_ALB" --scheme internet-facing --type application --region "$REGION" --query 'LoadBalancers[0].LoadBalancerArn' --output text)
fi
VPC_ID=$(aws ec2 describe-vpcs --vpc-ids "$VPC_ID" --region "$REGION" --query 'Vpcs[0].VpcId' --output text)
TG_ARN=$(aws elbv2 describe-target-groups --region "$REGION" --query "TargetGroups[?contains(TargetGroupName,'$NAME')].TargetGroupArn" --output text 2>/dev/null || true)
if [ -z "$TG_ARN" ] || [ "$TG_ARN" = "None" ]; then
  TG_ARN=$(aws elbv2 create-target-group --name "$NAME" --protocol HTTP --port 8080 --vpc-id "$VPC_ID" \
    --health-check-protocol HTTP --health-check-path /health --healthy-threshold-count 3 --unhealthy-threshold-count 3 \
    --region "$REGION" --query 'TargetGroups[0].TargetGroupArn' --output text)
fi
aws elbv2 register-targets --target-group-arn "$TG_ARN" --targets "Id=$INSTANCE_ID" --region "$REGION" >/dev/null 2>&1 || true

# wait for ACM issuance before wiring the HTTPS listener
say "waiting for ACM certificate to be issued"
for i in $(seq 1 30); do
  STS=$(aws acm describe-certificate --certificate-arn "$CERT_ARN" --region "$REGION" --query 'Certificate.Status' --output text)
  [ "$STS" = "ISSUED" ] && break
  sleep 10
done
[ "$STS" = "ISSUED" ] || { echo "cert not issued (status=$STS); check DNS validation records"; exit 1; }

# listeners: 443 with cert, 80 -> redirect to 443
LISTENER_HTTPS=$(aws elbv2 describe-listeners --load-balancer-arn "$ALB_ARN" --region "$REGION" --query "Listeners[?Port==\`443\`].ListenerArn" --output text 2>/dev/null || true)
if [ -z "$LISTENER_HTTPS" ] || [ "$LISTENER_HTTPS" = "None" ]; then
  aws elbv2 create-listener --load-balancer-arn "$ALB_ARN" --protocol HTTPS --port 443 --certificates "CertificateArn=$CERT_ARN" \
    --default-actions "Type=forward,TargetGroupArn=$TG_ARN" --region "$REGION" >/dev/null
fi
LISTENER_HTTP=$(aws elbv2 describe-listeners --load-balancer-arn "$ALB_ARN" --region "$REGION" --query "Listeners[?Port==\`80\`].ListenerArn" --output text 2>/dev/null || true)
if [ -z "$LISTENER_HTTP" ] || [ "$LISTENER_HTTP" = "None" ]; then
  aws elbv2 create-listener --load-balancer-arn "$ALB_ARN" --protocol HTTP --port 80 \
    --default-actions "Type=redirect,RedirectConfig={Protocol=HTTPS,Port=443,Host=#{host},Path=/#{path},Query=#{query},StatusCode=HTTP_301}" --region "$REGION" >/dev/null
fi

# ---------------------------------------------------------------------------
say "Route 53 A alias: $DOMAIN -> ALB"
ALB_DNS=$(aws elbv2 describe-load-balancers --load-balancer-arns "$ALB_ARN" --region "$REGION" --query 'LoadBalancers[0].DNSName' --output text)
ALB_ZONE=$(aws elbv2 describe-load-balancers --load-balancer-arns "$ALB_ARN" --region "$REGION" --query 'LoadBalancers[0].CanonicalHostedZoneId' --output text)
aws route53 change-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" --change-batch "{
  \"Changes\":[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{
    \"Name\":\"$DOMAIN\",\"Type\":\"A\",
    \"AliasTarget\":{\"HostedZoneId\":\"$ALB_ZONE\",\"DNSName\":\"$ALB_DNS\",\"EvaluateTargetHealth\":false}}}]}" >/dev/null

# ---------------------------------------------------------------------------
say "waiting for ALB target health ($DOMAIN)"
for i in $(seq 1 40); do
  STATE=$(aws elbv2 describe-target-health --target-group-arn "$TG_ARN" --region "$REGION" --query 'TargetHealthDescriptions[0].TargetHealth.State' --output text 2>/dev/null || true)
  [ "$STATE" = "healthy" ] && break
  sleep 15
done
echo "    target health: ${STATE:-unknown}"

say "done"
echo ""
echo "  endpoint : https://$DOMAIN/health"
echo "  metrics  : https://$DOMAIN/metrics"
echo "  instance : $INSTANCE_ID"
echo "  ssh      : ssh -i <$KEY_NAME.pem> ubuntu@$EIP"
echo "  data vol : /opt/viking/data  (secrets in /opt/viking/data/secrets/.env)"
echo "  token    : ssh ubuntu@$EIP 'sudo cat /opt/viking/data/secrets/.env | grep OPENVIKING_TOKEN'"
