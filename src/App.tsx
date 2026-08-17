import { Navigate, Route, Routes } from 'react-router-dom'
import Start from './pages/Start'
import Intake from './pages/Intake'
import Build from './pages/Build'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/start" replace />} />
      {/* PHASE 6: /start takes ?t={token} and exchanges it for a session cookie. */}
      <Route path="/start" element={<Start />} />
      <Route path="/intake/:jobId" element={<Intake />} />
      <Route path="/build/:jobId" element={<Build />} />
      <Route path="*" element={<Navigate to="/start" replace />} />
    </Routes>
  )
}
