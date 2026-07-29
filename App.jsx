import React, { useState, useEffect, useMemo, useRef } from "react";
import { Plus, X, Clock, ChevronLeft, ChevronRight, Trash2, Moon, Wallet } from "lucide-react";

// Storage shim — replaces the Claude-artifact-only window.storage with plain
// browser localStorage, so this app runs standalone once deployed.
const storage = {
  get: async (key) => {
    const v = localStorage.getItem(key);
    return v === null ? null : { value: v };
  },
  set: async (key, value) => {
    localStorage.setItem(key, value);
    return { value };
  },
};

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_FULL = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };

const TYPES = {
  start: { label: "Login", color: "#2E6B5E" },
  break: { label: "Break start", color: "#D6472C" },
  breakover: { label: "Break over", color: "#C98A3B" },
  end: { label: "Wrap up", color: "#5B6B73" },
  other: { label: "Other", color: "#6B7280" },
};

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

function fmtTime(t) {
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return { h: h12, m: String(m).padStart(2, "0"), ampm };
}

function jsDayToCode(jsDay) {
  return DAYS[(jsDay + 6) % 7];
}

// ---- Night pay math (minute-precise) ----
function timeToMin(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function minToLabel(absMin) {
  const m = ((absMin % 1440) + 1440) % 1440;
  const dayOffset = Math.floor(absMin / 1440);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const t = fmtTime(`${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`);
  return `${t.h}:${t.m} ${t.ampm}${dayOffset > 0 ? " +1" : ""}`;
}
function overlapMin(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}
function nightMinutesInRange(rangeStart, rangeEnd, nightStartMin, nightEndMin) {
  let nightDur = nightEndMin - nightStartMin;
  if (nightDur <= 0) nightDur += 1440;
  let total = 0;
  for (let dayOffset = -1; dayOffset <= 2; dayOffset++) {
    const occStart = nightStartMin + dayOffset * 1440;
    const occEnd = occStart + nightDur;
    total += overlapMin(rangeStart, rangeEnd, occStart, occEnd);
  }
  return total;
}
function buildShiftRange(shiftStartStr, shiftEndStr) {
  const s = timeToMin(shiftStartStr);
  let e = timeToMin(shiftEndStr);
  if (e <= s) e += 1440;
  return { start: s, end: e };
}
function buildLedger(shiftStartStr, shiftEndStr, nightStartStr, nightEndStr) {
  const { start, end } = buildShiftRange(shiftStartStr, shiftEndStr);
  const nightStartMin = timeToMin(nightStartStr);
  const nightEndMin = timeToMin(nightEndStr);
  const rows = [];
  let cursor = Math.floor(start / 60) * 60;
  while (cursor < end) {
    const blockStart = Math.max(cursor, start);
    const blockEnd = Math.min(cursor + 60, end);
    if (blockEnd > blockStart) {
      const nightMin = nightMinutesInRange(blockStart, blockEnd, nightStartMin, nightEndMin);
      const totalMin = blockEnd - blockStart;
      rows.push({ label: `${minToLabel(blockStart)} – ${minToLabel(blockEnd)}`, totalMin, nightMin, dayMin: totalMin - nightMin });
    }
    cursor += 60;
  }
  const totalMin = end - start;
  const nightMin = rows.reduce((s, r) => s + r.nightMin, 0);
  return { rows, totalMin, nightMin, dayMin: totalMin - nightMin };
}

// ---- Split-flap digit ----
function FlapChar({ char }) {
  const [displayChar, setDisplayChar] = useState(char);
  const [flipping, setFlipping] = useState(false);
  const prevChar = useRef(char);

  useEffect(() => {
    if (char !== prevChar.current) {
      setFlipping(true);
      const t = setTimeout(() => {
        setDisplayChar(char);
        setFlipping(false);
      }, 160);
      prevChar.current = char;
      return () => clearTimeout(t);
    }
  }, [char]);

  const isDigitish = /[0-9.,:₹\s]/.test(displayChar);

  return (
    <span className={`flap ${flipping ? "flap-flip" : ""} ${isDigitish ? "" : "flap-wide"}`}>
      {displayChar === " " ? "\u00A0" : displayChar}
    </span>
  );
}

function FlapReadout({ text, size = "text-3xl" }) {
  return (
    <span className={`font-flap ${size} inline-flex leading-none`}>
      {text.split("").map((c, i) => (
        <FlapChar key={i} char={c} />
      ))}
    </span>
  );
}

export default function App() {
  const [template, setTemplate] = useState([]);
  const [overrides, setOverrides] = useState({});
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState("week");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingAlarm, setEditingAlarm] = useState(null);
  const [selectedDate, setSelectedDate] = useState(null);
  const [cursorMonth, setCursorMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  useEffect(() => {
    (async () => {
      try {
        const t = await storage.get("board-template");
        if (t) setTemplate(JSON.parse(t.value));
      } catch (e) {}
      try {
        const o = await storage.get("board-overrides");
        if (o) setOverrides(JSON.parse(o.value));
      } catch (e) {}
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    storage.set("board-template", JSON.stringify(template)).catch(() => {});
  }, [template, loaded]);
  useEffect(() => {
    if (!loaded) return;
    storage.set("board-overrides", JSON.stringify(overrides)).catch(() => {});
  }, [overrides, loaded]);

  const sortedTemplate = useMemo(() => [...template].sort((a, b) => a.time.localeCompare(b.time)), [template]);
  const byDay = useMemo(() => {
    const map = {};
    DAYS.forEach((d) => (map[d] = []));
    sortedTemplate.forEach((a) => a.days.forEach((d) => map[d]?.push(a)));
    return map;
  }, [sortedTemplate]);

  function saveAlarm(alarm) {
    setTemplate((prev) => {
      const exists = prev.find((a) => a.id === alarm.id);
      if (exists) return prev.map((a) => (a.id === alarm.id ? alarm : a));
      return [...prev, alarm];
    });
    setModalOpen(false);
    setEditingAlarm(null);
  }
  function deleteAlarm(id) {
    setTemplate((prev) => prev.filter((a) => a.id !== id));
    setModalOpen(false);
    setEditingAlarm(null);
  }
  function toggleAlarmEnabled(id) {
    setTemplate((prev) => prev.map((a) => (a.id === id ? { ...a, enabled: a.enabled === false ? true : false } : a)));
  }
  function dateStr(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function effectiveAlarmsFor(date) {
    const code = jsDayToCode(date.getDay());
    const ds = dateStr(date);
    const ov = overrides[ds] || {};
    const skip = ov.skip || [];
    const base = template.filter((a) => a.enabled !== false && a.days.includes(code) && !skip.includes(a.id));
    const added = ov.added || [];
    return [...base, ...added].sort((a, b) => a.time.localeCompare(b.time));
  }
  function toggleSkipForDate(ds, alarmId) {
    setOverrides((prev) => {
      const cur = prev[ds] || { skip: [], added: [] };
      const skip = cur.skip.includes(alarmId) ? cur.skip.filter((x) => x !== alarmId) : [...cur.skip, alarmId];
      return { ...prev, [ds]: { ...cur, skip } };
    });
  }

  const monthCells = useMemo(() => {
    const first = cursorMonth;
    const startDay = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < startDay; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(first.getFullYear(), first.getMonth(), d));
    return cells;
  }, [cursorMonth]);

  const today = new Date();
  const isToday = (d) => d && d.toDateString() === today.toDateString();

  return (
    <div className="min-h-screen w-full bg-[#141517] text-[#EDEAE2] font-sans">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Space+Mono:wght@400;700&display=swap');
        .font-sans { font-family: 'Inter', system-ui, sans-serif; }
        .font-flap { font-family: 'Space Mono', monospace; }
        .flap {
          display: inline-block;
          background: #EDEAE2;
          color: #1B1D1F;
          min-width: 0.62em;
          text-align: center;
          border-radius: 3px;
          margin: 0 1.5px;
          padding: 0 3px;
          position: relative;
          box-shadow: inset 0 -3px 0 rgba(0,0,0,0.18), 0 1px 0 rgba(0,0,0,0.4);
        }
        .flap-wide { padding: 0 4px; color: #D6472C; background: transparent; box-shadow: none; }
        .flap::after {
          content: '';
          position: absolute;
          left: 2px; right: 2px; top: 50%;
          height: 1px;
          background: rgba(0,0,0,0.28);
        }
        .flap-flip { animation: flapFlip 0.32s ease; }
        @keyframes flapFlip {
          0% { transform: rotateX(0deg); }
          45% { transform: rotateX(-100deg); opacity: 0.35; }
          55% { transform: rotateX(90deg); opacity: 0.35; }
          100% { transform: rotateX(0deg); opacity: 1; }
        }
        .panel {
          background: #1C1E20;
          border: 1px solid rgba(255,255,255,0.06);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.03), 0 2px 8px rgba(0,0,0,0.3);
          position: relative;
        }
        .rivet { position: absolute; width: 5px; height: 5px; border-radius: 50%; background: rgba(255,255,255,0.08); box-shadow: inset 0 1px 1px rgba(0,0,0,0.5); }
      `}</style>

      {/* Header */}
      <div className="px-5 pt-8 pb-4 sticky top-0 bg-[#141517]/95 backdrop-blur z-10 border-b-2 border-[#0E0F10]">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-[0.22em] text-[#8A8E93] font-bold">Remote Work OS</p>
            <h1 className="text-2xl font-extrabold tracking-tight">SHIFT BOARD</h1>
          </div>
          <button
            onClick={() => { setEditingAlarm({ id: uid(), time: "09:00", label: "", type: "other", days: [], enabled: true }); setModalOpen(true); }}
            className="w-11 h-11 rounded-full bg-[#D6472C] flex items-center justify-center active:scale-95 transition shadow-[0_2px_0_rgba(0,0,0,0.4)]"
          >
            <Plus size={22} color="#EDEAE2" strokeWidth={2.5} />
          </button>
        </div>

        {/* Week pulse strip */}
        <div className="flex gap-1.5 mt-5">
          {DAYS.map((d) => {
            const count = byDay[d]?.filter((a) => a.enabled !== false).length || 0;
            const height = count === 0 ? 4 : Math.min(28, 8 + count * 6);
            return (
              <div key={d} className="flex-1 flex flex-col items-center gap-1.5">
                <div className="w-full h-7 flex items-end">
                  <div className="w-full rounded-sm transition-all" style={{ height: `${height}px`, background: count > 0 ? "#D6472C" : "#26282B" }} />
                </div>
                <span className="text-[10px] text-[#6B7280] font-bold font-flap">{d[0]}</span>
              </div>
            );
          })}
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mt-5 bg-[#1C1E20] rounded-lg p-1 border border-white/5">
          {[["week", "Week"], ["month", "Month"], ["pay", "Night Pay"]].map(([k, label]) => (
            <button
              key={k}
              onClick={() => setView(k)}
              className={`flex-1 py-2 rounded-md text-xs font-bold uppercase tracking-wide transition ${
                view === k ? "bg-[#D6472C] text-[#141517]" : "text-[#8A8E93]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* WEEK VIEW */}
      {view === "week" && (
        <div className="px-5 py-5 space-y-6 pb-24">
          {sortedTemplate.length === 0 && (
            <div className="text-center py-16">
              <div className="flex justify-center gap-1 mb-4">
                {["-", "-", ":", "-", "-"].map((c, i) => (
                  <span key={i} className="flap font-flap text-2xl opacity-40">{c}</span>
                ))}
              </div>
              <p className="text-[#6B7280] text-sm">Board's empty. Tap + to set your first break or shift alarm.</p>
            </div>
          )}
          {DAYS.map((day) => {
            const alarms = byDay[day];
            if (!alarms || alarms.length === 0) return null;
            return (
              <div key={day}>
                <p className="text-[11px] uppercase tracking-[0.18em] text-[#8A8E93] font-bold mb-2 border-b border-white/5 pb-1.5">{DAY_FULL[day]}</p>
                <div className="space-y-2 mt-2">
                  {alarms.map((a) => {
                    const t = fmtTime(a.time);
                    const disabled = a.enabled === false;
                    return (
                      <div
                        key={a.id + day}
                        onClick={() => { setEditingAlarm(a); setModalOpen(true); }}
                        className={`panel flex items-center justify-between rounded-lg px-4 py-3 active:bg-[#202226] transition ${disabled ? "opacity-35" : ""}`}
                      >
                        <div className="rivet" style={{ top: 4, left: 4 }} />
                        <div className="rivet" style={{ bottom: 4, right: 4 }} />
                        <div className="flex items-center gap-3">
                          <div className="w-1.5 h-9 rounded-sm" style={{ background: TYPES[a.type]?.color || "#6B7280" }} />
                          <div>
                            <div className="flex items-baseline gap-1 font-flap font-bold">
                              <span className="text-xl">{t.h}:{t.m}</span>
                              <span className="text-[10px] text-[#8A8E93]">{t.ampm}</span>
                            </div>
                            <p className="text-sm text-[#B4B0A8] mt-0.5">{a.label || TYPES[a.type]?.label}</p>
                          </div>
                        </div>
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleAlarmEnabled(a.id); }}
                          className={`w-11 h-6 rounded-full flex items-center px-0.5 transition ${disabled ? "bg-[#2A2D33] justify-start" : "bg-[#D6472C] justify-end"}`}
                        >
                          <div className="w-5 h-5 rounded-full bg-[#EDEAE2]" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* MONTH VIEW */}
      {view === "month" && (
        <div className="px-5 py-5 pb-24">
          <div className="flex items-center justify-between mb-4">
            <button onClick={() => setCursorMonth(new Date(cursorMonth.getFullYear(), cursorMonth.getMonth() - 1, 1))} className="p-2">
              <ChevronLeft size={20} color="#8A8E93" />
            </button>
            <p className="font-flap font-bold text-lg uppercase tracking-wide">{cursorMonth.toLocaleString("default", { month: "long", year: "numeric" })}</p>
            <button onClick={() => setCursorMonth(new Date(cursorMonth.getFullYear(), cursorMonth.getMonth() + 1, 1))} className="p-2">
              <ChevronRight size={20} color="#8A8E93" />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-1 mb-1">
            {DAYS.map((d) => (
              <div key={d} className="text-center text-[10px] text-[#6B7280] font-bold py-1 font-flap">{d[0]}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {monthCells.map((d, i) => {
              if (!d) return <div key={i} />;
              const alarms = effectiveAlarmsFor(d);
              const selected = selectedDate && dateStr(d) === dateStr(selectedDate);
              return (
                <button
                  key={i}
                  onClick={() => setSelectedDate(d)}
                  className={`panel aspect-square rounded-lg flex flex-col items-center justify-center gap-1 transition ${
                    selected ? "!bg-[#D6472C]" : isToday(d) ? "!bg-[#2A2D33]" : ""
                  }`}
                >
                  <span className={`text-sm font-bold font-flap ${selected ? "text-[#141517]" : "text-[#EDEAE2]"}`}>{d.getDate()}</span>
                  <div className="flex gap-0.5">
                    {alarms.slice(0, 3).map((a, idx) => (
                      <div key={idx} className="w-1 h-1 rounded-full" style={{ background: selected ? "#141517" : TYPES[a.type]?.color || "#6B7280" }} />
                    ))}
                  </div>
                </button>
              );
            })}
          </div>

          {selectedDate && (
            <div className="panel mt-5 rounded-lg p-4">
              <p className="font-bold mb-3 uppercase tracking-wide text-sm">{selectedDate.toLocaleDateString("default", { weekday: "long", month: "long", day: "numeric" })}</p>
              {effectiveAlarmsFor(selectedDate).length === 0 && <p className="text-sm text-[#6B7280]">No alarms scheduled this day.</p>}
              <div className="space-y-2">
                {effectiveAlarmsFor(selectedDate).map((a) => {
                  const t = fmtTime(a.time);
                  return (
                    <div key={a.id} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="w-1.5 h-6 rounded-sm" style={{ background: TYPES[a.type]?.color }} />
                        <span className="font-flap font-bold">{t.h}:{t.m} {t.ampm}</span>
                        <span className="text-sm text-[#B4B0A8]">{a.label || TYPES[a.type]?.label}</span>
                      </div>
                      <button onClick={() => toggleSkipForDate(dateStr(selectedDate), a.id)} className="text-[11px] text-[#D6472C] font-bold uppercase tracking-wide">
                        Skip
                      </button>
                    </div>
                  );
                })}
              </div>
              <p className="text-[11px] text-[#6B7280] mt-3">Skipping only affects this date — your weekly pattern stays the same.</p>
            </div>
          )}
        </div>
      )}

      {view === "pay" && <NightPayCalculator />}

      {modalOpen && editingAlarm && (
        <AlarmModal alarm={editingAlarm} onClose={() => { setModalOpen(false); setEditingAlarm(null); }} onSave={saveAlarm} onDelete={template.find((a) => a.id === editingAlarm.id) ? deleteAlarm : null} />
      )}
    </div>
  );
}

function NightPayCalculator() {
  const [rate, setRate] = useState("");
  const [nightStart, setNightStart] = useState("19:30");
  const [nightEnd, setNightEnd] = useState("08:30");
  const [shiftStart, setShiftStart] = useState("19:30");
  const [shiftEnd, setShiftEnd] = useState("08:30");
  const [log, setLog] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [showLedger, setShowLedger] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const c = await storage.get("board-pay-config");
        if (c) {
          const p = JSON.parse(c.value);
          setRate(p.rate ?? ""); setNightStart(p.nightStart ?? "19:30"); setNightEnd(p.nightEnd ?? "08:30");
          setShiftStart(p.shiftStart ?? "19:30"); setShiftEnd(p.shiftEnd ?? "08:30");
        }
      } catch (e) {}
      try {
        const l = await storage.get("board-pay-log");
        if (l) setLog(JSON.parse(l.value));
      } catch (e) {}
      setLoaded(true);
    })();
  }, []);
  useEffect(() => {
    if (!loaded) return;
    storage.set("board-pay-config", JSON.stringify({ rate, nightStart, nightEnd, shiftStart, shiftEnd })).catch(() => {});
  }, [rate, nightStart, nightEnd, shiftStart, shiftEnd, loaded]);
  useEffect(() => {
    if (!loaded) return;
    storage.set("board-pay-log", JSON.stringify(log)).catch(() => {});
  }, [log, loaded]);

  const ledger = useMemo(() => {
    try { return buildLedger(shiftStart, shiftEnd, nightStart, nightEnd); } catch (e) { return { rows: [], totalMin: 0, nightMin: 0, dayMin: 0 }; }
  }, [shiftStart, shiftEnd, nightStart, nightEnd]);

  const numRate = parseFloat(rate) || 0;
  const nightHours = ledger.nightMin / 60;
  const dayHours = ledger.dayMin / 60;
  const totalHours = ledger.totalMin / 60;
  const nightPay = nightHours * numRate;

  function addToLog() {
    if (!numRate || ledger.totalMin === 0) return;
    setLog((prev) => [{ id: uid(), date: new Date().toISOString().slice(0, 10), shiftStart, shiftEnd, nightHours, pay: nightPay }, ...prev]);
  }
  function removeLogEntry(id) { setLog((prev) => prev.filter((e) => e.id !== id)); }

  const monthKey = new Date().toISOString().slice(0, 7);
  const monthTotal = log.filter((e) => e.date.startsWith(monthKey)).reduce((s, e) => s + e.pay, 0);
  const monthHours = log.filter((e) => e.date.startsWith(monthKey)).reduce((s, e) => s + e.nightHours, 0);

  return (
    <div className="px-5 py-5 pb-24 space-y-5">
      <div className="panel rounded-lg p-4">
        <div className="flex items-center gap-2 mb-4">
          <Moon size={16} color="#D6472C" />
          <p className="text-[11px] uppercase tracking-[0.18em] text-[#8A8E93] font-bold">Night window (fixed daily)</p>
        </div>
        <div className="flex gap-3 mb-5">
          <div className="flex-1">
            <p className="text-[11px] text-[#6B7280] mb-1 uppercase tracking-wide">Starts</p>
            <input type="time" value={nightStart} onChange={(e) => setNightStart(e.target.value)} className="w-full bg-[#141517] border border-white/5 rounded-lg px-3 py-2 font-flap font-bold outline-none" style={{ colorScheme: "dark" }} />
          </div>
          <div className="flex-1">
            <p className="text-[11px] text-[#6B7280] mb-1 uppercase tracking-wide">Ends</p>
            <input type="time" value={nightEnd} onChange={(e) => setNightEnd(e.target.value)} className="w-full bg-[#141517] border border-white/5 rounded-lg px-3 py-2 font-flap font-bold outline-none" style={{ colorScheme: "dark" }} />
          </div>
        </div>

        <p className="text-[11px] uppercase tracking-[0.18em] text-[#8A8E93] font-bold mb-2 border-t border-white/5 pt-4">This shift</p>
        <div className="flex gap-3 mb-4">
          <div className="flex-1">
            <p className="text-[11px] text-[#6B7280] mb-1 uppercase tracking-wide">Clock in</p>
            <input type="time" value={shiftStart} onChange={(e) => setShiftStart(e.target.value)} className="w-full bg-[#141517] border border-white/5 rounded-lg px-3 py-2 font-flap font-bold outline-none" style={{ colorScheme: "dark" }} />
          </div>
          <div className="flex-1">
            <p className="text-[11px] text-[#6B7280] mb-1 uppercase tracking-wide">Clock out</p>
            <input type="time" value={shiftEnd} onChange={(e) => setShiftEnd(e.target.value)} className="w-full bg-[#141517] border border-white/5 rounded-lg px-3 py-2 font-flap font-bold outline-none" style={{ colorScheme: "dark" }} />
          </div>
        </div>

        <p className="text-[11px] uppercase tracking-[0.18em] text-[#8A8E93] font-bold mb-1">Hourly rate</p>
        <div className="flex items-center bg-[#141517] border border-white/5 rounded-lg px-3 py-2">
          <span className="text-[#8A8E93] mr-1 font-bold">₹</span>
          <input type="number" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="0.00" className="w-full bg-transparent font-flap font-bold outline-none placeholder:text-[#3A3D42]" />
          <span className="text-[#6B7280] text-xs">/ hr</span>
        </div>
      </div>

      {/* Summary — the flip-board moment */}
      <div className="panel rounded-lg p-4">
        <div className="grid grid-cols-3 gap-2 text-center mb-4">
          <div>
            <FlapReadout text={totalHours.toFixed(2)} size="text-xl" />
            <p className="text-[9px] uppercase tracking-wide text-[#6B7280] mt-2 font-bold">Total hrs</p>
          </div>
          <div>
            <FlapReadout text={nightHours.toFixed(2)} size="text-xl" />
            <p className="text-[9px] uppercase tracking-wide text-[#6B7280] mt-2 font-bold">Night hrs</p>
          </div>
          <div>
            <FlapReadout text={dayHours.toFixed(2)} size="text-xl" />
            <p className="text-[9px] uppercase tracking-wide text-[#6B7280] mt-2 font-bold">Day hrs</p>
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-white/5 pt-4">
          <div className="flex items-center gap-2">
            <Wallet size={16} color="#D6472C" />
            <span className="text-sm text-[#B4B0A8] font-semibold uppercase tracking-wide">Night allowance</span>
          </div>
          <FlapReadout text={`₹${nightPay.toFixed(2)}`} size="text-2xl" />
        </div>

        <button onClick={() => setShowLedger((v) => !v)} className="text-[11px] text-[#8A8E93] font-bold uppercase tracking-wide mt-4 underline">
          {showLedger ? "Hide" : "Show"} hour-by-hour breakdown
        </button>

        {showLedger && (
          <div className="mt-3 space-y-1.5">
            {ledger.rows.map((r, i) => (
              <div key={i} className="flex items-center justify-between text-xs border-b border-white/5 py-1">
                <span className="text-[#B4B0A8] font-flap">{r.label}</span>
                <span>
                  <span className="font-flap font-bold" style={{ color: r.nightMin > 0 ? "#D6472C" : "#3A3D42" }}>{(r.nightMin / 60).toFixed(2)}h night</span>
                  {r.dayMin > 0 && <span className="font-flap font-bold text-[#2E6B5E] ml-2">{(r.dayMin / 60).toFixed(2)}h day</span>}
                </span>
              </div>
            ))}
            {ledger.rows.length === 0 && <p className="text-xs text-[#6B7280]">Set a clock-in and clock-out time above.</p>}
          </div>
        )}

        <button
          onClick={addToLog}
          disabled={!numRate || ledger.totalMin === 0}
          className={`w-full mt-4 py-3 rounded-lg font-bold text-sm uppercase tracking-wide transition ${
            !numRate || ledger.totalMin === 0 ? "bg-[#1C1E20] text-[#3A3D42]" : "bg-[#D6472C] text-[#141517] active:scale-[0.98]"
          }`}
        >
          Add today's shift to monthly log
        </button>
      </div>

      {log.length > 0 && (
        <div className="panel rounded-lg p-4">
          <div className="flex items-center justify-between mb-3 border-b border-white/5 pb-3">
            <p className="text-[11px] uppercase tracking-[0.18em] text-[#8A8E93] font-bold">This month</p>
            <FlapReadout text={`₹${monthTotal.toFixed(2)}`} size="text-base" />
          </div>
          <div className="space-y-2">
            {log.map((e) => (
              <div key={e.id} className="flex items-center justify-between text-sm">
                <div>
                  <span className="font-flap font-bold">{e.date}</span>
                  <span className="text-[#6B7280] ml-2 text-xs">{fmtTime(e.shiftStart).h}:{fmtTime(e.shiftStart).m}{fmtTime(e.shiftStart).ampm}–{fmtTime(e.shiftEnd).h}:{fmtTime(e.shiftEnd).m}{fmtTime(e.shiftEnd).ampm}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-flap font-bold">₹{e.pay.toFixed(2)}</span>
                  <button onClick={() => removeLogEntry(e.id)}><X size={14} color="#6B7280" /></button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AlarmModal({ alarm, onClose, onSave, onDelete }) {
  const [time, setTime] = useState(alarm.time);
  const [label, setLabel] = useState(alarm.label);
  const [type, setType] = useState(alarm.type);
  const [days, setDays] = useState(alarm.days);

  function toggleDay(d) {
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-end z-50" onClick={onClose}>
      <div className="w-full bg-[#1C1E20] border-t-2 border-[#D6472C] rounded-t-2xl p-5 pb-8" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <button onClick={onClose}><X size={22} color="#8A8E93" /></button>
          <p className="font-bold uppercase tracking-wide text-sm">{onDelete ? "Edit alarm" : "New alarm"}</p>
          <button
            onClick={() => days.length > 0 && onSave({ ...alarm, time, label, type, days })}
            disabled={days.length === 0}
            className={`font-bold text-sm uppercase tracking-wide ${days.length === 0 ? "text-[#3A3D42]" : "text-[#D6472C]"}`}
          >
            Save
          </button>
        </div>

        <div className="flex justify-center mb-6">
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="bg-transparent text-4xl font-flap font-bold text-center outline-none" style={{ colorScheme: "dark" }} />
        </div>

        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (e.g. Break time, Login)" className="w-full bg-[#141517] border border-white/5 rounded-lg px-4 py-3 text-sm mb-4 outline-none placeholder:text-[#6B7280]" />

        <p className="text-[11px] uppercase tracking-wide text-[#8A8E93] font-bold mb-2">Type</p>
        <div className="flex flex-wrap gap-2 mb-5">
          {Object.entries(TYPES).map(([k, v]) => (
            <button key={k} onClick={() => setType(k)} className={`px-3 py-1.5 rounded-md text-xs font-bold uppercase tracking-wide border transition ${type === k ? "border-transparent" : "border-white/10 text-[#8A8E93]"}`} style={type === k ? { background: v.color, color: "#141517" } : {}}>
              {v.label}
            </button>
          ))}
        </div>

        <p className="text-[11px] uppercase tracking-wide text-[#8A8E93] font-bold mb-2">Repeats on</p>
        <div className="flex gap-1.5 mb-2">
          {DAYS.map((d) => (
            <button key={d} onClick={() => toggleDay(d)} className={`w-10 h-10 rounded-md text-xs font-bold transition ${days.includes(d) ? "bg-[#D6472C] text-[#141517]" : "bg-[#141517] text-[#6B7280] border border-white/5"}`}>
              {d[0]}
            </button>
          ))}
        </div>
        {days.length === 0 && <p className="text-[11px] text-[#D6472C] mb-2">Pick at least one day.</p>}

        {onDelete && (
          <button onClick={() => onDelete(alarm.id)} className="w-full flex items-center justify-center gap-2 mt-4 py-3 text-sm font-bold uppercase tracking-wide text-[#D6472C]">
            <Trash2 size={16} /> Delete alarm
          </button>
        )}
      </div>
    </div>
  );
}
