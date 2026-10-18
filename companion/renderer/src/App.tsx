export function App() {
  const bridge = window.castcade;
  return (
    <main className="shell">
      <h1>Castcade</h1>
      <dl>
        <dt>app</dt>
        <dd>{bridge?.appVersion ?? 'unknown'}</dd>
        <dt>protocol</dt>
        <dd>{bridge?.protocolVersion ?? 'unknown'}</dd>
        <dt>platform</dt>
        <dd>{bridge?.platform ?? 'unknown'}</dd>
      </dl>
      <p className="status">match engine: idle</p>
    </main>
  );
}
