import { Navigate, Route, Routes } from 'react-router-dom'
import Start from './pages/Start'
import Intake from './pages/Intake'
import Build from './pages/Build'
import Preview from './pages/Preview'
import GoLive from './pages/GoLive'
import Discharge from './pages/Discharge'
import DemoCheckout from './pages/DemoCheckout'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/start" replace />} />
      {/* PHASE 6: /start takes ?t={token} and exchanges it for a session cookie. */}
      <Route path="/start" element={<Start />} />
      <Route path="/intake/:jobId" element={<Intake />} />
      <Route path="/build/:jobId" element={<Build />} />
      <Route path="/preview/:jobId" element={<Preview />} />
      <Route path="/golive/:jobId" element={<GoLive />} />
      <Route path="/discharge/:jobId" element={<Discharge />} />
      {/* Local preview only. The route exists in all builds; the API behind it refuses
          to run unless DEMO_MODE is on. */}
      <Route path="/demo/checkout" element={<DemoCheckout />} />
      <Route path="*" element={<Navigate to="/start" replace />} />
    </Routes>
  )
}
