import { useCallback, useEffect, useState } from 'react';
import { describe } from '../useCastcade.js';

/**
 * D7.6 + D7.6.3 (2026-11-03): the VR test bench's own controls on the Match tab (kept in this file so the bench's card
 * in Match.tsx stays one line). The bench puts this rig's headset in theater with no second player (media/bench.ts):
 * a saved clip or this rig's own table live from the layer camera, straight to the layer or through a local WebRTC loop
 * (so the encoder's detail and bitrate are in the picture), with a live readout. Save 2 s of frames writes the layer
 * camera's frames (the sender side) and the theater frames handed to the layer (the receiver side) to
 * `<logs>/frames/<date>/`, for offline analysis and for the bench to replay (media/frame-clip.ts).
 * D7.6.10 (2026-11-04): the stereo window's sliders (depth, a vertical offset per eye, soft edge) live below the bench's
 * controls; they are match settings, applied at once like Theater size, in a match and on the bench.
 */

type SourcePick = { kind: 'live' } | { kind: 'clip'; name: string; side: 'sender' | 'receiver' };

/** The source options: own table live, then each saved clip's eye frames and received frames, newest first. */
function sourceOptions(clips: ClipSummary[]): Array<{ value: string; label: string; pick: SourcePick }> {
  const out: Array<{ value: string; label: string; pick: SourcePick }> = [{ value: 'live', label: 'My own table, live (the VR layer camera)', pick: { kind: 'live' } }];
  for (const c of clips) {
    if (c.sender) {
      const eye = c.sender.eye ? `, ${c.sender.eye.width}x${c.sender.eye.height} per eye` : '';
      out.push({ value: `${c.name}|sender`, label: `Clip ${c.name}: ${c.sender.count} eye frames${eye}${c.sender.fps ? ` at ${c.sender.fps} fps` : ''}`, pick: { kind: 'clip', name: c.name, side: 'sender' } });
    }
    if (c.receiver) {
      const size = c.receiver.size ? `, ${c.receiver.size.width}x${c.receiver.size.height}${c.receiver.stereo ? ` ${c.receiver.stereo}` : ''}` : '';
      out.push({ value: `${c.name}|receiver`, label: `Clip ${c.name}: ${c.receiver.count} received frames${size}${c.receiver.fps ? ` at ${c.receiver.fps} fps` : ''}`, pick: { kind: 'clip', name: c.name, side: 'receiver' } });
    }
  }
  return out;
}

/** D7.6.9 (2026-11-03): the loop's bitrate cap: the match's rule, or a fixed cap to find where the picture stops looking bad. */
const BITRATE_CAPS: Array<{ value: string; label: string; bitrate: number | null }> = [
  { value: 'rule', label: "The match's rule (8 Mbps for stereo)", bitrate: null },
  { value: '16', label: '16 Mbps', bitrate: 16_000_000 },
  { value: '30', label: '30 Mbps', bitrate: 30_000_000 },
  { value: '50', label: '50 Mbps', bitrate: 50_000_000 },
];

/**
 * D7.5.10 (2026-11-04): the stereo window's depth: infinity (the layer's default, the frames as rendered) or nearer, for
 * the owner's finding that the window fused but its frame doubled (the frames sat at infinity while the eyes converged
 * on the table). 2.6 m is the layer's screen distance.
 */
const WINDOW_DEPTHS: Array<{ value: string; label: string; depthM: number | null }> = [
  { value: 'inf', label: 'Infinity (as rendered)', depthM: null },
  { value: '5', label: '5 m', depthM: 5 },
  { value: '2.6', label: '2.6 m (the screen distance)', depthM: 2.6 },
  { value: '1.5', label: '1.5 m', depthM: 1.5 },
  { value: '1', label: '1 m', depthM: 1 },
  { value: '0.7', label: '0.7 m', depthM: 0.7 },
];

/** D7.5.11 (2026-11-04): the window's soft edge, as a fraction of one eye's half width. */
const SOFT_EDGES: Array<{ value: string; label: string; feather: number }> = [
  { value: '0', label: 'Off', feather: 0 },
  { value: '0.01', label: '1%', feather: 0.01 },
  { value: '0.03', label: '3%', feather: 0.03 },
  { value: '0.06', label: '6%', feather: 0.06 },
  { value: '0.1', label: '10%', feather: 0.1 },
];

const depthValue = (m: number | null): string => WINDOW_DEPTHS.find((d) => d.depthM === m)?.value ?? (m === null ? 'inf' : String(m));
const edgeValue = (f: number): string => SOFT_EDGES.find((s) => s.feather === f)?.value ?? String(f);

/**
 * D7.6.10 (2026-11-04): the stereo window's live sliders (match settings, saved and applied at once like Theater size,
 * in a match and on the bench; `onStatus` takes the status the patch answers with). Shown whether or not the bench runs.
 */
function WindowTuning({ bridge, st, onStatus }: { bridge: CastcadeBridge; st: MatchStatus; onStatus?: (s: MatchStatus) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [dy, setDy] = useState<[string, string] | null>(null);
  const s = st.settings;
  const patch = (p: Partial<Pick<MatchSettings, 'windowDepthM' | 'eyeOffsetDeg' | 'softEdge'>>) => {
    setError(null);
    void bridge.match.setSettings(p).then(
      (next) => onStatus?.(next),
      (e: unknown) => setError(describe(e)),
    );
  };
  // The number fields hold the text while it is typed; the setting goes on each change that parses, the saved value shows otherwise.
  const shown = (i: 0 | 1): string => (dy ? dy[i] : s.eyeOffsetDeg[i].toFixed(1));
  const offset = (i: 0 | 1, text: string) => {
    const next: [string, string] = [shown(0), shown(1)];
    next[i] = text;
    setDy(next);
    const n = Number(text);
    if (text.trim() === '' || !Number.isFinite(n)) return;
    const deg: [number, number] = [...s.eyeOffsetDeg];
    deg[i] = n;
    patch({ eyeOffsetDeg: deg });
  };
  return (
    <>
      <div className="row">
        <label className="field">
          <span>Window depth</span>
          <select value={depthValue(s.windowDepthM)} onChange={(e) => patch({ windowDepthM: WINDOW_DEPTHS.find((d) => d.value === e.target.value)?.depthM ?? null })}>
            {WINDOW_DEPTHS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Vertical offset, left eye</span>
          <input type="number" step="0.1" min="-3" max="3" value={shown(0)} onChange={(e) => offset(0, e.target.value)} onBlur={() => setDy(null)} />
        </label>
        <label className="field">
          <span>Vertical offset, right eye</span>
          <input type="number" step="0.1" min="-3" max="3" value={shown(1)} onChange={(e) => offset(1, e.target.value)} onBlur={() => setDy(null)} />
        </label>
        <label className="field">
          <span>Soft edge</span>
          <select value={edgeValue(s.softEdge)} onChange={(e) => patch({ softEdge: SOFT_EDGES.find((x) => x.value === e.target.value)?.feather ?? 0.03 })}>
            {SOFT_EDGES.map((x) => (
              <option key={x.value} value={x.value}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <small>
        Window depth moves the window's frame nearer than infinity; the vertical offsets shift one eye's picture up or down (a non-zero value needed to
        fuse means the reported field of view is off); Soft edge fades the frame into the black. All three apply at once and go into the VR report.
      </small>
      {error && <p className="error">{error}</p>}
    </>
  );
}

export function TestBench({ bridge, st, onStatus, bare = false }: { bridge: CastcadeBridge; st: MatchStatus; onStatus?: (s: MatchStatus) => void; bare?: boolean }) {
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
            {bench.state === 'running' ? 'Running' : 'Starting'}: {bench.source === 'live' ? 'your own table, live' : bench.clip}, {bench.path === 'loop' ? 'through the local WebRTC loop' : 'straight to the layer'}.
          </small>
          <small>{bench.readout}</small>
          <small>{bench.hint}</small>
        </>
      ) : (
        <small>
          {inMatch
            ? 'The bench runs only without a match.'
            : 'Theater alone in your headset, no second player: start VPX in VR with the table, pick a source and a path, then Start. Theater size above applies at once. Stop gives VPX its own view back.'}
        </small>
      )}
      <small>
        Save 2 s of frames writes your VR layer camera's eye frames (while it runs: Camera = VR layer in a match, or the bench on your own table) and the theater
        frames handed to your headset (while theater shows) to the logs folder, at most 120 of each; the bench can play them back. Pressed while the
        bench runs through the local WebRTC loop, it keeps the encoded picture (the frames as they came out of the loop), so the encoder's work can be
        looked at offline.
      </small>
      {saved && (
        <small>
          {saved.dir ? `Saved ${saved.sender} eye frame(s) and ${saved.receiver} theater frame(s) to ${saved.dir}.` : 'Nothing saved.'}
          {saved.notes.length ? ` ${saved.notes.join('; ')}.` : ''}
        </small>
      )}
      {error && <p className="error">{error}</p>}
      {/* D7.6.10: the stereo window's sliders, live whether or not the bench runs. */}
      <WindowTuning bridge={bridge} st={st} onStatus={onStatus} />
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
