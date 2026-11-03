import { useState } from 'react';
import { describe } from '../useCastcade.js';

/**
 * D7.6.3 (2026-11-03): the VR test bench's own controls on the Match tab (kept in this file so the bench's card in
 * Match.tsx stays one line). Save 2 s of frames writes the layer camera's frames (the sender side) and the theater
 * frames handed to the layer (the receiver side) to `<logs>/frames/<date>/`, for offline analysis and for the bench to
 * replay (media/frame-clip.ts).
 */
export function TestBench({ bridge, bare = false }: { bridge: CastcadeBridge; st: MatchStatus; bare?: boolean }) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<SaveFramesResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    setSaving(true);
    setError(null);
    void bridge.match
      .saveFrames()
      .then(
        (r) => setSaved(r),
        (e: unknown) => setError(describe(e)),
      )
      .finally(() => setSaving(false));
  };

  const body = (
    <>
      <div className="row">
        <button type="button" className="small" disabled={saving} onClick={save}>
          {saving ? 'Saving 2 s of frames…' : 'Save 2 s of frames'}
        </button>
      </div>
      <small>
        Writes your VR layer camera's eye frames (while it runs: Camera = VR layer in a match, or the bench on your own table) and the theater frames handed to
        your headset (while theater shows) to the logs folder, at most 120 of each.
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
