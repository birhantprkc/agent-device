// Types only, so the adb provider can carry a supplied IME helper without importing the helper
// implementation (the same split `snapshot-helper-types.ts` makes for the snapshot helper).

export type AndroidImeHelperManifest = {
  name: 'android-ime-helper';
  version: string;
  assetName: string;
  sha256: string;
  packageName: string;
  versionCode: number;
  serviceComponent: string;
  broadcastProtocol: 'android-ime-helper-v1';
};

export type AndroidImeHelperArtifact = {
  apkPath: string;
  manifest: AndroidImeHelperManifest;
};
