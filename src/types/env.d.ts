/// <reference types="vite/client" />

/** Path of the pinned OpenCV.js build, relative to the app (set by build/plugins.ts). */
declare const __OPENCV_FILE__: string;

interface ImportMetaEnv {
  readonly VITE_PEER_HOST?: string;
  readonly VITE_PEER_PORT?: string;
  readonly VITE_PEER_PATH?: string;
  readonly VITE_PEER_SECURE?: string;
  readonly VITE_PEER_KEY?: string;
}
