import { usingPublicBroker } from '../../net/peer';
import { TopBar } from '../components';
import { navigate } from '../router';

export function Help() {
  return (
    <main class="screen prose">
      <TopBar title="How it works" onBack={() => navigate('/')} />

      <section>
        <h2>The idea</h2>
        <p>
          One phone hosts and shows a code. Everyone else scans it and stands in a curve around the subject. A countdown runs on every
          screen, driven by the host's clock, and every phone keeps the frame taken closest to the same instant. The host lines the photos
          up, matches their colours and turns them into a short clip that sweeps around the frozen moment — then sends it back to everyone.
        </p>
      </section>

      <section>
        <h2>Setting up</h2>
        <ul>
          <li>
            <strong>Same Wi-Fi works best.</strong> Or turn on the host's hotspot and have everyone join it.
          </li>
          <li>
            <strong>Stand in a curve</strong> around the subject, about 2–3 metres away, spaced evenly. Follow the numbers on your screen
            (“You are #3 of 10”), left to right.
          </li>
          <li>
            <strong>Aim at the subject</strong>: keep it inside the circle, hold the phone at chest height, level (the line turns cyan).
          </li>
          <li>
            <strong>Hold still</strong> through the countdown and a moment after it.
          </li>
          <li>Ask the subject for permission before you start.</li>
        </ul>
      </section>

      <section>
        <h2>How the phones stay in sync</h2>
        <p>
          Each phone measures the difference between its clock and the host's by bouncing 30+ tiny messages off the host and keeping the
          fastest round trips. Cameras stream continuously into a short rolling buffer; after the moment passes, each phone picks the frame
          whose timestamp is closest to it. Typical accuracy: about one video frame (~33 ms at 30 fps) plus the sync uncertainty the host
          screen shows for every phone.
        </p>
      </section>

      <section>
        <h2>Sync Test Mode</h2>
        <p>
          In the lobby, the host can start a sync test: the host screen shows a running clock with a machine-readable code, everyone points
          their phone at it, and the app reads the exact time each phone really captured. You get a measured error for every phone — and the
          host can store it as a per-phone correction for the next moments.
        </p>
      </section>

      <section>
        <h2>Manual mode</h2>
        <p>
          If direct connections fail (some mobile networks block them), use manual mode. The host shows a QR code with the moment's time;
          people scan it with their camera app, and their phone counts down on its own clock (optionally fine-tuned by pointing the camera
          at the host's screen). Afterwards everyone sends their photo — or a short video covering the moment — to the host by any messaging
          app. The host imports them; for videos, the app finds the host's “moment chirp” in the soundtrack and takes that frame. Slower,
          but it always works.
        </p>
      </section>

      <section>
        <h2>Honest limits</h2>
        <ul>
          <li>
            Timing between phones is typically within a few hundredths of a second. Very fast motion (a ball, a splash) may look slightly
            staggered.
          </li>
          <li>
            Different phone cameras and lenses create variation. Alignment and colour matching reduce it but don't remove it entirely. The
            look is “stylish stop-motion”, not a perfect studio rig.
          </li>
          <li>Direct connections work best on shared Wi-Fi or a hotspot; some mobile networks block them — use manual mode.</li>
          <li>
            {usingPublicBroker()
              ? 'Connections are set up through the free public PeerJS signalling server, which is best-effort. Self-hosting it makes the app more reliable.'
              : 'Connections are set up through a self-hosted signalling server.'}
          </li>
          <li>Phones that don't report when a camera frame was captured get an estimated correction; running a sync test measures it.</li>
        </ul>
      </section>

      <section>
        <h2>Privacy</h2>
        <p>
          Photos travel directly from phone to phone over encrypted WebRTC connections: to the host, and the finished clip back to the
          people in the moment. Nothing is uploaded to a server. The signalling server only helps phones find each other.
        </p>
      </section>

      <section>
        <h2>Troubleshooting</h2>
        <ul>
          <li>
            <strong>Camera blocked:</strong> allow camera access for this site in your browser settings and reload.
          </li>
          <li>
            <strong>Can't connect:</strong> make sure you're on the host's Wi-Fi or hotspot, and that the host's screen stays on. Otherwise
            use manual mode.
          </li>
          <li>
            <strong>Photos misaligned:</strong> in the editor, tap a photo and tap the subject in it, or nudge it with the arrows.
          </li>
        </ul>
      </section>
      <div class="bottom-actions">
        <button class="btn block" onClick={() => navigate('/')}>
          Back
        </button>
      </div>
    </main>
  );
}
