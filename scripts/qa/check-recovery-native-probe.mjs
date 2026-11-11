import assert from "node:assert/strict";
import { runRecoveryBundleProbe } from "./isolated-native-evidence.mjs";

const runToken = "qa-recovery-guard";
const identifier = "com.lightmark.qa.recoveryguard";
const expectedProfile = "C:\\LightMark-QA\\recoveryguard\\EBWebView";
const targetNonce = `${runToken}-recovery-bundle-nonce`;
const vitePort = 41731;
const cdpPort = 41732;
const webSocketDebuggerUrl = `ws://127.0.0.1:${cdpPort}/devtools/page/owned`;
const phase = {
  name: "recovery-bundle",
  targetNonce,
  vitePort,
  cdpPort,
  pid: 1234,
  target: {
    type: "page",
    url: `http://127.0.0.1:${vitePort}/?lightmarkQa=${encodeURIComponent(targetNonce)}`,
    webSocketDebuggerUrl,
  },
  loopback: {
    listeners: [{
      process: {
        profileArgument: expectedProfile,
        chain: [{ ProcessId: 1234 }],
      },
    }],
  },
};
const context = {
  runToken,
  identifier,
  expectedWebviewProfileDir: expectedProfile,
  manifest: {
    isolation: { preexistingPathsChecked: true },
    launch: { phases: [phase] },
  },
};

await assert.rejects(
  () => runRecoveryBundleProbe({ url: webSocketDebuggerUrl }, {}),
  /isolated launcher run token|verified profile/,
);
await assert.rejects(
  () => runRecoveryBundleProbe({ url: `ws://127.0.0.1:${cdpPort}/devtools/page/foreign` }, context),
  /verified page target|bound to the launcher's verified page target/,
);
await assert.rejects(
  () => runRecoveryBundleProbe({ url: webSocketDebuggerUrl }, {
    ...context,
    manifest: {
      ...context.manifest,
      launch: {
        phases: [{
          ...phase,
          target: {
            ...phase.target,
            url: `http://127.0.0.1:${vitePort}/?lightmarkQa=foreign-${encodeURIComponent(targetNonce)}`,
          },
        }],
      },
    },
  }),
  /verified page target|expected page identity/,
);
await assert.rejects(
  () => runRecoveryBundleProbe({ url: webSocketDebuggerUrl }, {
    ...context,
    manifest: {
      ...context.manifest,
      launch: {
        phases: [{
          ...phase,
          loopback: { listeners: [{ process: { profileArgument: "C:\\foreign\\profile", chain: [{ ProcessId: 1234 }] } }] },
        }],
      },
    },
  }),
  /owned WebView2 profile/,
);
await assert.rejects(
  () => runRecoveryBundleProbe({ url: webSocketDebuggerUrl }, {
    ...context,
    manifest: {
      ...context.manifest,
      launch: {
        phases: [{
          ...phase,
          loopback: {
            listeners: [{
              process: {
                profileArgument: expectedProfile,
                chain: [{ ProcessId: 9876 }],
              },
            }],
          },
        }],
      },
    },
  }),
  /process tree/,
);

console.log(JSON.stringify({
  message: "recovery native probe refuses missing launcher identity, foreign page targets/nonces, foreign profiles, and foreign process-chain metadata",
  checked: ["launcher-identity", "page-nonce-and-websocket", "owned-profile", "owned-process-chain"],
  evidence: "guard-negative metadata fixtures; a native launch must still retain the launcher manifest's verified process/profile observations",
}, null, 2));
