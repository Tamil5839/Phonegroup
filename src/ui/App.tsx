import { Help } from './screens/Help';
import { Home } from './screens/Home';
import { HostApp } from './host/HostApp';
import { route } from './router';
import { JoinApp } from './shooter/JoinApp';
import { ManualShooter } from './shooter/ManualShooter';

export function App() {
  const r = route.value;
  switch (r.name) {
    case 'host':
      return <HostApp key="host" />;
    case 'manual-host':
      return <HostApp key="manual" offline />;
    case 'join':
      return <JoinApp code={r.code} />;
    case 'manual-shoot':
      return <ManualShooter key={`${r.code}-${r.moment}`} code={r.code} moment={r.moment} epoch={r.epoch} />;
    case 'help':
      return <Help />;
    default:
      return <Home />;
  }
}
