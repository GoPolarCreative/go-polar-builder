import { Navigate, Route, Routes } from 'react-router-dom'
import Start from './pages/Start'
import Intake from './pages/Intake'
import Build from './pages/Build'
import Preview, { ChangesPanel } from './pages/Preview'
import Answers from './pages/Answers'
import GoLive from './pages/GoLive'
import Discharge from './pages/Discharge'
import Ops from './pages/Ops'
import DemoCheckout from './pages/DemoCheckout'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/start" replace />} />
      {/* PHASE 6: /start takes ?t={token} and exchanges it for a session cookie. */}
      <Route path="/start" element={<Start />} />
      <Route path="/intake/:jobId" element={<Intake />} />
      <Route path="/build/:jobId" element={<Build />} />
      {/*
        The three screens of a finished build are three addresses, not three panels behind a
        toggle. Back works, a link can be sent, and none of them is a slice of a very long scroll
        on a phone.

        /changes is nested inside /preview on purpose: React Router keeps the parent mounted, so
        opening the chat does not tear down and reload the preview iframe, and the customer's place
        on their own page survives the trip.
      */}
      <Route path="/preview/:jobId" element={<Preview />}>
        <Route path="changes" element={<ChangesPanel />} />
      </Route>
      <Route path="/answers/:jobId" element={<Answers />} />
      <Route path="/golive/:jobId" element={<GoLive />} />
      <Route path="/discharge/:jobId" element={<Discharge />} />
      {/* Go Polar only. Guarded by ADMIN_TOKEN, which the page asks for. */}
      <Route path="/ops" element={<Ops />} />
      {/* Local preview only. The route exists in all builds; the API behind it refuses
          to run unless DEMO_MODE is on. */}
      <Route path="/demo/checkout" element={<DemoCheckout />} />
      <Route path="*" element={<Navigate to="/start" replace />} />
    </Routes>
  )
}
