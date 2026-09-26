import { useEffect, useState } from 'preact/hooks';
import { EditScreen } from '../edit/EditScreen';
import { ResultScreen } from '../edit/ResultScreen';
import { TopBar } from '../components';
import { navigate } from '../router';
import { CaptureView } from './CaptureView';
import { HostController } from './controller';
import { Lobby } from './Lobby';
import { ManualSchedule } from './ManualSchedule';
import { SyncTestView } from './SyncTestView';

export function HostApp({ offline = false }: { offline?: boolean }) {
  const [ctl] = useState(() => new HostController(offline));
  useEffect(() => {
    void ctl.start();
    const warn = (e: BeforeUnloadEvent) => {
      if (ctl.session?.shooters.value.some((s) => !s.isHost) || ctl.project.value) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
      ctl.dispose();
    };
  }, [ctl]);

  const status = ctl.status.value;
  if (status === 'starting') {
    return (
      <main class="screen">
        <TopBar title="Creating your moment" onBack={() => navigate('/')} />
        <div class="notice" role="status">
          Reserving a room code…
        </div>
      </main>
    );
  }
  if (status === 'error') {
    return (
      <main class="screen">
        <TopBar title="Couldn't create the moment" onBack={() => navigate('/')} />
        <div class="notice error">{ctl.error.value}</div>
        <p class="muted">The free connection service may be busy. You can retry, or use manual mode, which works without any connection.</p>
        <div class="bottom-actions">
          <button class="btn primary block" onClick={() => void ctl.start()}>
            Try again
          </button>
          <button class="btn block" onClick={() => navigate('/manual')}>
            Use manual mode
          </button>
        </div>
      </main>
    );
  }

  const view = ctl.view.value;
  const project = ctl.project.value;
  const result = ctl.result.value;

  if (view === 'result' && result) {
    return (
      <ResultScreen
        result={result}
        delivery={ctl.session?.delivery.value}
        shooters={ctl.session?.shooters.value}
        onEdit={() => ctl.editAgain()}
        onNew={() => ctl.newMoment()}
      />
    );
  }
  if (view === 'edit' && project) {
    return (
      <EditScreen
        project={project}
        onBack={() => {
          if (confirm('Discard these photos and go back?')) ctl.newMoment();
        }}
        onCreate={() => void ctl.createClip()}
        onCancelExport={() => ctl.cancelExport()}
        onImport={(files) => void ctl.importMedia(files)}
        exporting={ctl.exporting.value}
        exportError={ctl.exportError.value}
        importNote={ctl.importNote.value}
        importing={ctl.importing.value}
      />
    );
  }
  if (view === 'manual') return <ManualSchedule ctl={ctl} />;
  if (!ctl.session) return null;
  if (view === 'synctest') return <SyncTestView ctl={ctl} />;
  const phase = ctl.session.phase.value;
  if (view === 'capture' || phase === 'syncing' || phase === 'countdown' || phase === 'collecting') return <CaptureView ctl={ctl} />;
  return <Lobby ctl={ctl} />;
}
