import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Strategies from './pages/Strategies';
import RaceResult from './pages/RaceResult';
import Navbar from './components/Navbar';

function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-slate-900 text-white">
        <Navbar />
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/strategies" element={<Strategies />} />
          <Route path="/race/:taskId" element={<RaceResult />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}

export default App;
