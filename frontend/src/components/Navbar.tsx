import { Link, useLocation } from 'react-router-dom';

export default function Navbar() {
  const { pathname } = useLocation();
  const isActive = (path: string) => pathname === path;

  return (
    <nav className="sticky top-0 z-50 border-b border-white/8 bg-[#0a0a0f]/80 backdrop-blur-xl">
      <div className="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2">
          <span className="text-xl">🧠</span>
          <span className="font-black text-white text-lg tracking-tight">Agent Lab</span>
        </Link>
        <div className="flex items-center gap-1">
          {[
            { to: '/', label: '⚡ Race' },
            { to: '/strategies', label: '📊 History' },
          ].map(({ to, label }) => (
            <Link
              key={to}
              to={to}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all duration-200
                ${isActive(to)
                  ? 'bg-white/10 text-white'
                  : 'text-white/40 hover:text-white/70 hover:bg-white/5'}
              `}
            >
              {label}
            </Link>
          ))}
        </div>
      </div>
    </nav>
  );
}
