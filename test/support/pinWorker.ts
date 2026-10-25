/** Child process of safe-git-state2.test.ts: records `count` pins into the shared pin file, then exits. */
import { pinStore, stateHooks } from "../../src/git/safeGitState.ts";

const [stateRoot, tag, count] = process.argv.slice(2);
stateHooks.stateRoot = stateRoot as string;
for (let i = 0; i < Number(count); i++) {
  pinStore.setPin(`/pins/${tag}/${i}`, `url-${tag}-${i}`);
  if (i % 2 === 0) pinStore.setRepo(`/trees/${tag}/${i}`, `/pins/${tag}/${i}`);
}
