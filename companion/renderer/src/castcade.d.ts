/** Shape of the preload's contextBridge (see `companion/src/preload/index.cts`). */
interface CastcadeBridge {
  readonly appVersion: string;
  readonly protocolVersion: number;
  readonly platform: string;
}

interface Window {
  readonly castcade?: CastcadeBridge;
}
