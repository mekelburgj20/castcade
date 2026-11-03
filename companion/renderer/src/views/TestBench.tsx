import { useCallback, useEffect, useState } from 'react';
import { describe } from '../useCastcade.js';

/**
 * D7.6 + D7.6.3 (2026-11-03): the VR test bench's own controls on the Match tab (kept in this file so the bench's card
 * in Match.tsx stays one line). The bench puts this rig's headset in theater with no second player (media/bench.ts):
 * a saved clip or this rig's own table live from the layer camera, straight to the layer or through a local WebRTC loop
 * (so the encoder's detail and bitrate are in the picture), with a live readout. Save 2 s of frames writes the layer
 * camera's frames (the sender side) and the theater frames handed to the layer (the receiver side) to
 * `<logs>/frames/<date>/`, for offline analysis and for the bench to replay (media/frame-clip.ts).
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

export function TestBench({ bridge, st, bare = false }: { bridge: CastcadeBridge; st: MatchStatus; bare?: boolean }) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<SaveFramesResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clips, setClips] = useState<ClipSummary[]>([]);
  const [source, setSource] = useState('live');
  const [path, setPath] = useState<'direct' | 'loop'>('direct');
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
    act(() => bridge.match.benchStart({ source: p.kind, path, clip: p.kind === 'clip' ? { name: p.name, side: p.side } : null }));
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
        frames handed to your headset (while theater shows) to the logs folder, at most 120 of each; the bench can play them back.
      </small>
      {saved && (
        <small>
          {saved.dir ? `Saved ${saved.sender} eye frame(s) and ${saved.receiver} theater frame(s) to ${saved.dir}.` : 'Nothing saved.'}
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
