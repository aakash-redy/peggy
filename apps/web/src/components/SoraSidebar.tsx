import { useState } from "react";
import {
  Disc3,
  Frame,
  Zap,
  Grip,
  Wind,
  Briefcase,
  Plus,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

const domains = [
  { label: "Braking", icon: Disc3 },
  { label: "Chassis", icon: Frame },
  { label: "Tractive System (EV)", icon: Zap },
  { label: "Suspension", icon: Grip },
  { label: "Aerodynamics", icon: Wind },
  { label: "Business", icon: Briefcase },
];

const rulebookVersions = ["2026 Rules", "2027 Rules", "Compare Both"] as const;

interface SoraSidebarProps {
  activeDomain: string;
  onDomainChange: (d: string) => void;
  ruleVersion: string;
  onRuleVersionChange: (v: string) => void;
  onNewChat: () => void;
}

export default function SoraSidebar({
  activeDomain,
  onDomainChange,
  ruleVersion,
  onRuleVersionChange,
  onNewChat,
}: SoraSidebarProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={`relative flex flex-col border-r border-border bg-sidebar transition-all duration-300 ease-out ${
        collapsed ? "w-16" : "w-64"
      }`}
    >
      {/* Collapse toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="absolute -right-3 top-6 z-10 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition-colors hover:text-foreground"
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
      </button>

      {/* Logo */}
      <div className="flex h-14 items-center gap-2 px-4">
        <Zap size={20} className="shrink-0 text-primary" />
        {!collapsed && (
          <span className="text-sm font-semibold tracking-wide text-foreground">
            HEXAWATTS <span className="text-muted-foreground">|</span>{" "}
            <span className="text-primary">SORA</span>
          </span>
        )}
      </div>

      {/* New Chat */}
      <div className="px-3 pb-4">
        <button
          onClick={onNewChat}
          className="flex w-full items-center justify-center gap-2 rounded-pill border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary/40 hover:text-primary active:scale-[0.97]"
        >
          <Plus size={16} />
          {!collapsed && "New Chat"}
        </button>
      </div>

      {/* Domain selector */}
      {!collapsed && (
        <div className="flex-1 overflow-y-auto px-3">
          <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            Engineering Domain
          </p>
          <ul className="space-y-0.5">
            {domains.map((d) => {
              const active = activeDomain === d.label;
              return (
                <li key={d.label}>
                  <button
                    onClick={() => onDomainChange(d.label)}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors active:scale-[0.97] ${
                      active
                        ? "bg-primary/10 font-medium text-primary"
                        : "text-sidebar-foreground hover:bg-card hover:text-foreground"
                    }`}
                  >
                    <d.icon size={16} className={active ? "text-primary" : ""} />
                    {d.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Collapsed domain icons */}
      {collapsed && (
        <div className="flex flex-1 flex-col items-center gap-1 pt-2">
          {domains.map((d) => {
            const active = activeDomain === d.label;
            return (
              <button
                key={d.label}
                onClick={() => onDomainChange(d.label)}
                title={d.label}
                className={`rounded-lg p-2 transition-colors active:scale-[0.95] ${
                  active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <d.icon size={18} />
              </button>
            );
          })}
        </div>
      )}

      {/* Rulebook version */}
      {!collapsed && (
        <div className="border-t border-border px-3 py-4">
          <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            Rulebook Version
          </p>
          <div className="flex flex-col gap-1">
            {rulebookVersions.map((v) => (
              <button
                key={v}
                onClick={() => onRuleVersionChange(v)}
                className={`rounded-md px-3 py-1.5 text-left text-sm transition-colors active:scale-[0.97] ${
                  ruleVersion === v
                    ? "bg-primary/10 font-medium text-primary"
                    : "text-muted-foreground hover:bg-card hover:text-foreground"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}
