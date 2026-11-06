import { useCallback, useEffect, useState } from 'react';
import { describe } from '../useCastcade.js';

/**
 * D7.6 + D7.6.3 (2026-11-03): the VR test bench's own controls on the Match tab (kept in this file so the bench's card
 * in Match.tsx stays one line). The bench puts this rig's headset in theater with no second player (media/bench.ts):
 * a saved clip or this rig's own table live from the layer camera, straight to the layer or through a local WebRTC loop
 * (so the encoder's detail and bitrate are in the picture), with a live readout. Save 2 s of frames writes the layer
 * camera's frames (the sender side) and the theater frames handed to the layer (the receiver side) to
 * `<logs>/frames/<date>/`, for offline analysis and for the bench to replay (media/frame-clip.ts).
 * D8.7 (2026-11-05, ADR 0009): spectating is 2D, so the bench shows this rig's own table as the other players will see
 * it: a flat screen. The stereo window's sliders of D7.6.10 (depth, a vertical offset per eye, soft edge) are withdrawn
 * from the tab; their settings (`windowDepthM`, `eyeOffsetDeg`, `softEdge`) stay in the settings file, the IPC and the
 * layer protocol as 0.2.35 shipped them.
 */

type SourcePick = { kind: 'live' } | { kind: 'clip'; name: string; side: 'sender' | 'receiver' };

/** The source options: own table live, then each saved clip's camera frames and received frames, newest first. */
function sourceOptions(clips: ClipSummary[]): Array<{ value: string; label: string; pick: SourcePick }> {
  const out: Array<{ value: string; label: string; pick: SourcePick }> = [{ value: 'live', label: 'My own table, live, as the other players will see it (the VR layer camera)', pick: { kind: 'live' } }];
  for (const c of clips) {
    if (c.sender) {
      const eye = c.sender.eye ? `, ${c.sender.eye.width}x${c.sender.eye.height}` : '';
      out.push({ value: `${c.name}|sender`, label: `Clip ${c.name}: ${c.sender.count} camera frames${eye}${c.sender.fps ? ` at ${c.sender.fps} fps` : ''}`, pick: { kind: 'clip', name: c.name, side: 'sender' } });
    }
    if (c.receiver) {
      // A clip recorded while the stereo window was in use (0.2.27–0.2.35) is both eyes side by side; the flat picture needs no word.
      const size = c.receiver.size ? `, ${c.receiver.size.width}x${c.receiver.size.height}${c.receiver.stereo === 'sbs' ? ' both eyes' : ''}` : '';
      out.push({ value: `${c.name}|receiver`, label: `Clip ${c.name}: ${c.receiver.count} received frames${size}${c.receiver.fps ? ` at ${c.receiver.fps} fps` : ''}`, pick: { kind: 'clip', name: c.name, side: 'receiver' } });
    }
  }
  return out;
}

/** D7.6.9 (2026-11-03): the loop's bitrate cap: the match's rule, or a fixed cap to find where the picture stops looking bad. */
const BITRATE_CAPS: Array<{ value: string; label: string; bitrate: number | null }> = [
  { value: 'rule', label: "The match's rule (by picture size, up to 8 Mbps)", bitrate: null },
  { value: '16', label: '16 Mbps', bitrate: 16_000_000 },
  { value: '30', label: '30 Mbps', bitrate: 30_000_000 },
  { value: '50', label: '50 Mbps', bitrate: 50_000_000 },
];

export function TestBench({ bridge, st, bare = false }: { bridge: CastcadeBridge; st: MatchStatus; onStatus?: (s: MatchStatus) => void; bare?: boolean }) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<SaveFramesResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clips, setClips] = useState<ClipSummary[]>([]);
  const [source, setSource] = useState('live');
  const [path, setPath] = useState<'direct' | 'loop'>('direct');
  const [cap, setCap] = useState('rule');
  const [busy, setBusy] = useState(false);
  const bench = st.bench;
  const inMatch = st.role !== 'none';

  const refreshClips = useCallback(() => {
    void bridge.match.benchClips().then(setClips, () => setClips([]));
  }, [bridge]);
  useEffect(() => refreshClips(), [refreshClips]);

  const options = sourceOptions(clips);
  const chosen = options.find((o) => o.value === source) ?? options[0]!;

  const save = () => {
    setSaving(true);
    setError(null);
    void bridge.match
      .saveFrames()
      .then(
        (r) => {
          setSaved(r);
          refreshClips();
        },
        (e: unknown) => setError(describe(e)),
      )
      .finally(() => setSaving(false));
  };
  const act = (fn: () => Promise<MatchStatus>) => {
    setBusy(true);
    setError(null);
    void fn()
      .catch((e: unknown) => setError(describe(e)))
      .finally(() => setBusy(false));
  };
  const start = () => {
    const p = chosen.pick;
    const bitrate = path === 'loop' ? (BITRATE_CAPS.find((c) => c.value === cap)?.bitrate ?? null) : null;
    act(() => bridge.match.benchStart({ source: p.kind, path, clip: p.kind === 'clip' ? { name: p.name, side: p.side } : null, bitrate }));
  };

  const body = (
    <>
      <div className="row">
        <label className="field">
          <span>Source</span>
          <select value={chosen.value} disabled={!!bench} onChange={(e) => setSource(e.target.value)}>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Path</span>
          <select value={path} disabled={!!bench} onChange={(e) => setPath(e.target.value === 'loop' ? 'loop' : 'direct')}>
            <option value="direct">Straight to the layer (no encoder)</option>
            <option value="loop">Through a local WebRTC loop (the match's encoder and bitrate)</option>
          </select>
        </label>
        {path === 'loop' && (
          <label className="field">
            <span>Bitrate cap</span>
            <select value={cap} disabled={!!bench} onChange={(e) => setCap(e.target.value)}>
              {BITRATE_CAPS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="row">
        {bench ? (
          <>
            <button type="button" className="small" disabled={busy} onClick={() => act(() => bridge.match.benchStop())}>
              Stop
            </button>
            {bench.headset && (
              <button type="button" className="small" disabled={busy || bench.state !== 'running'} onClick={() => act(() => bridge.match.benchView(bench.view === 'theater' ? 'direct' : 'theater'))}>
                {bench.view === 'theater' ? "Show VPX's own view" : 'Show the bench picture'}
              </button>
            )}
          </>
        ) : (
          <button type="button" className="small" disabled={busy || inMatch} onClick={start}>
            Start
          </button>
        )}
        <button type="button" className="small" disabled={saving} onClick={save}>
          {saving ? 'Saving 2 s of frames…' : 'Save 2 s of frames'}
        </button>
      </div>
      {bench ? (
        <>
          <small>
            {bench.state === 'running' ? 'Running' : 'Starting'}: {bench.source === 'live' ? 'your own table, live, as the other players will see it' : bench.clip},{' '}
            {bench.path === 'loop' ? 'through the local WebRTC loop' : 'straight to the layer'}.
          </small>
          <small>{bench.readout}</small>
          <small>{bench.hint}</small>
        </>
      ) : (
        <small>
          {inMatch
            ? 'The bench runs only without a match.'
            : 'Your own table on the theater screen in your headset, as the other players will see it, no second player: start VPX in VR with the table, pick a source and a path, then Start. Theater size above applies at once. Stop gives VPX its own view back.'}
        </small>
      )}
      <small>
        Save 2 s of frames writes your VR layer camera's frames (while it runs: Camera = VR layer in a match, or the bench on your own table) and the theater
        frames handed to your headset (while theater shows) to the logs folder, at most 120 of each; the bench can play them back. Pressed while the
        bench runs through the local WebRTC loop, it keeps the encoded picture (the frames as they came out of the loop), so the encoder's work can be
        looked at offline.
      </small>
      {saved && (
        <small>
          {saved.dir ? `Saved ${saved.sender} camera frame(s) and ${saved.receiver} theater frame(s) to ${saved.dir}.` : 'Nothing saved.'}
          {saved.notes.length ? ` ${saved.notes.join('; ')}.` : ''}
        </small>
      )}
      {error && <p className="error">{error}</p>}
    </>
  );
  // Inside another card (the VR test bench card of D7.6.1 / D7.6.2), no card of its own.
  if (bare) return body;
  return (
    <div className="card">
      <strong>VR test bench</strong>
      {body}
    </div>
  );
}
