import React, { useEffect, useState } from 'react';
import * as XLSX from 'xlsx';

const TEMPO_TOKEN = import.meta.env.VITE_TEMPO_TOKEN || '';
const JIRA_USER = import.meta.env.VITE_APP_JIRA_USER || '';
const JIRA_PASS = import.meta.env.VITE_APP_JIRA_PASS || '';

const JIRA_AUTH = (JIRA_USER && JIRA_PASS) ? 'Basic ' + btoa(`${JIRA_USER}:${JIRA_PASS}`) : '';
const BASE_URL_TEMPO = '/api-tempo';
const BASE_URL_JIRA = '/api-jira';

const userCache: { [key: string]: string } = {};
const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

const App: React.FC = () => {
  const [allProjectList, setAllProjectList] = useState<any[]>([]);
  const [displayData, setDisplayData] = useState<any[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [initialLoad, setInitialLoad] = useState(true);

  // --- LÓGICA DE FECHAS AUTOMÁTICA ---
  const getMonthDates = () => {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return {
      first: first.toISOString().split('T')[0],
      last: last.toISOString().split('T')[0]
    };
  };

  const initialDates = getMonthDates();
  const [dateFrom, setDateFrom] = useState(initialDates.first);
  const [dateTo, setDateTo] = useState(initialDates.last);
  // ----------------------------------

  const [projectSearch, setProjectSearch] = useState('');
  const [userSearch, setUserSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('ALL');
  const [filterType, setFilterType] = useState('ALL');
  const [viewMode, setViewMode] = useState('ONLY_DATA');

  useEffect(() => {
    const savedData = localStorage.getItem('tempo_displayData');
    const savedIndex = localStorage.getItem('tempo_currentIndex');
    if (savedData) setDisplayData(JSON.parse(savedData));
    if (savedIndex) setCurrentIndex(parseInt(savedIndex));

    const fetchFullProjectList = async () => {
      try {
        let allItems: any[] = [];
        let offset = 0;
        let hasMore = true;
        while (hasMore) {
          const res = await fetch(`${BASE_URL_TEMPO}/projects?offset=${offset}&limit=100`, { headers: { Authorization: `Bearer ${TEMPO_TOKEN}` } });
          const json = await res.json();
          if (json.results?.length > 0) {
            allItems = [...allItems, ...json.results.map((p: any) => ({ id: p.id, key: p.key, name: p.name }))];
            if (json.metadata?.next) offset += 100; else hasMore = false;
          } else hasMore = false;
        }
        setAllProjectList(allItems);
      } catch (e) { console.error("Error inicial:", e); } finally { setInitialLoad(false); }
    };
    fetchFullProjectList();
  }, []);

  const fetchJiraName = async (selfUrl: string, accountId: string) => {
    if (userCache[accountId]) return userCache[accountId];
    try {
      const res = await fetch(selfUrl.replace('https://ayudatsoft.atlassian.net', BASE_URL_JIRA), { headers: { 'Authorization': JIRA_AUTH } });
      if (res.ok) { const data = await res.json(); userCache[accountId] = data.displayName; return data.displayName; }
    } catch (e) { }
    return accountId;
  };

  const loadAllRemaining = async () => {
    if (loading) return;
    setLoading(true);
    const remaining = allProjectList.slice(currentIndex);

    for (let i = 0; i < remaining.length; i++) {
      const project = remaining[i];
      const absoluteIndex = currentIndex + i + 1;
      setLoadingMessage(`Procesando ${absoluteIndex}/${allProjectList.length}: ${project.name}`);

      let allProjectApprovals: any[] = [];
      let url: string | null = `${BASE_URL_TEMPO}/projects/${project.id}/time-approvals?from=${dateFrom}&to=${dateTo}&limit=50`;

      while (url) {
        try {
          await delay(250);
          const res = await fetch(url, { headers: { Authorization: `Bearer ${TEMPO_TOKEN}` } });
          if (!res.ok) break;
          const json = await res.json();
          const enriched = await Promise.all((json.results || []).map(async (auth: any) => ({ ...auth, userName: await fetchJiraName(auth.user?.userLink?.linked?.self || '', auth.user.id) })));
          allProjectApprovals = [...allProjectApprovals, ...enriched];
          url = json.metadata?.next ? json.metadata.next.replace('https://api.tempo.io/4', BASE_URL_TEMPO) : null;
        } catch (e) { break; }
      }

      setDisplayData((prev: any[]) => {
        const newData = [...prev, { id: project.id, projectName: project.name || project.key, approvals: allProjectApprovals }];
        localStorage.setItem('tempo_displayData', JSON.stringify(newData));
        return newData;
      });
      setCurrentIndex(absoluteIndex);
      localStorage.setItem('tempo_currentIndex', absoluteIndex.toString());
    }
    setLoading(false);
    setLoadingMessage('');
  };

  const approveHours = async (projectId: string, from: string, to: string, accountId: string, userName: string) => {
    if (!window.confirm(`¿Aprobar horas de ${userName}?`)) return;
    const res = await fetch(`${BASE_URL_TEMPO}/projects/${projectId}/time-approvals/approve`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TEMPO_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamMemberIds: [accountId], period: { from, to }, comment: "Aprobado mediante Panel Tsoft" })
    });
    if (res.ok) {
      setDisplayData((prev: any[]) => {
        const updated = prev.map((p: any) => p.id === projectId ? { ...p, approvals: p.approvals.map((a: any) => a.user.id === accountId ? { ...a, status: { key: 'APPROVED' } } : a) } : p);
        localStorage.setItem('tempo_displayData', JSON.stringify(updated));
        return updated;
      });
      alert(`✅ ¡Horas de ${userName} aprobadas!`);
    }
  };

  const exportToExcel = () => {
    const rows = filteredData.flatMap((p: any) => p.approvals.map((a: any) => ({ Proyecto: p.projectName, Colaborador: a.userName, Estado: a.status.key, Horas: (a.timeSpentSeconds / 3600).toFixed(2), Desde: a.period.from, Hasta: a.period.to })));
    if (rows.length === 0) return alert("⚠️ No hay datos.");
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Aprobaciones");
    XLSX.writeFile(wb, `Control_Tempo_${dateFrom}.xlsx`);
  };

  const filteredData = displayData.map((proj: any) => ({ ...proj, approvals: proj.approvals.filter((auth: any) => (filterStatus === 'ALL' || auth.status.key === filterStatus) && (auth.userName || '').toLowerCase().includes(userSearch.toLowerCase())) })).filter((proj: any) => proj.projectName.toLowerCase().includes(projectSearch.toLowerCase()) && (filterType === 'ALL' || proj.projectName.toUpperCase().startsWith(filterType)) && (viewMode === 'ALL' || proj.approvals.length > 0));

  if (initialLoad) return <div style={s.loading}>Sincronizando Proyectos...</div>;

  return (
    <div style={s.container}>
      <div style={s.header}>
        <h1 style={s.title}>Control de Horas Tsoft</h1>
        <div style={{ display: 'flex', gap: '10px' }}>
          {currentIndex < allProjectList.length && <button onClick={loadAllRemaining} disabled={loading} style={s.btnLoad}>{loading ? `⏳ ${loadingMessage}` : `🚀 Cargar Pendientes (${allProjectList.length - currentIndex})`}</button>}
          <button onClick={exportToExcel} style={s.btnExcel}>Excel 📥</button>
        </div>
      </div>
      <div style={s.filterBar}>
        <div style={s.filterGroup}><label style={s.label}>Desde:</label><input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={s.input} /></div>
        <div style={s.filterGroup}><label style={s.label}>Hasta:</label><input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={s.input} /></div>
        <button onClick={() => { setDisplayData([]); setCurrentIndex(0); localStorage.clear(); window.location.reload(); }} style={s.btnSearch}>🔍 Reiniciar</button>
        <div style={s.divider} />
        <div style={s.filterGroup}><label style={s.label}>Tipo:</label><select value={filterType} onChange={e => setFilterType(e.target.value)} style={s.input}><option value="ALL">Todos</option><option value="PROY">PROY</option><option value="PREV">PREV</option></select></div>
        <div style={s.filterGroup}><label style={s.label}>Estado:</label><select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={s.input}><option value="ALL">Todos los Estados</option><option value="APPROVED">APPROVED</option><option value="IN_REVIEW">IN_REVIEW</option><option value="OPEN">OPEN</option></select></div>
        <div style={s.filterGroup}><label style={s.label}>Mostrar:</label><select value={viewMode} onChange={e => setViewMode(e.target.value)} style={{ ...s.input, backgroundColor: '#fff3cd' }}><option value="ONLY_DATA">Solo con registros</option><option value="ALL">Ver todos</option></select></div>
        <input type="text" placeholder="Proyecto..." value={projectSearch} onChange={e => setProjectSearch(e.target.value)} style={s.input} />
        <input type="text" placeholder="Colaborador..." value={userSearch} onChange={e => setUserSearch(e.target.value)} style={s.input} />
      </div>
      <div style={s.tableContainer}>
        <table style={s.table}>
          <thead><tr style={{ backgroundColor: '#f1f2f6' }}><th style={s.th}>Proyecto</th><th style={s.th}>Colaborador</th><th style={s.th}>Estado</th><th style={s.th}>Horas</th><th style={s.th}>Periodo</th></tr></thead>
          <tbody>{filteredData.map((proj: any, i: number) => proj.approvals.length > 0 ? proj.approvals.map((auth: any, j: number) => <tr key={`${i}-${j}`} style={s.tr}>{j === 0 && <td rowSpan={proj.approvals.length} style={s.tdProject}>{proj.projectName}</td>}<td style={s.td}>{auth.userName}</td><td style={s.td}><div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}><span style={{ color: auth.status.key === 'APPROVED' ? '#27ae60' : '#e67e22', fontWeight: 'bold' }}>{auth.status.key}</span>{auth.status.key !== 'APPROVED' && <button onClick={() => approveHours(proj.id, auth.period.from, auth.period.to, auth.user.id, auth.userName)} style={s.btnApprove}>✅</button>}</div></td><td style={s.td}>{(auth.timeSpentSeconds / 3600).toFixed(2)}h</td><td style={s.td}>{auth.period.from} / {auth.period.to}</td></tr>) : <tr key={`empty-${i}`} style={{ ...s.tr, backgroundColor: '#fdfdfd' }}><td style={{ ...s.tdProject, color: '#999' }}>{proj.projectName}</td><td colSpan={4} style={{ ...s.td, color: '#ccc', fontStyle: 'italic' }}>Sin registros</td></tr>)}</tbody>
        </table>
      </div>
    </div>
  );
};

const s = {
  container: { padding: '20px', fontFamily: 'Arial' },
  header: { display: 'flex', justifyContent: 'space-between', marginBottom: '20px' },
  title: { fontSize: '22px', fontWeight: 'bold' },
  filterBar: { display: 'flex', gap: '10px', padding: '15px', backgroundColor: '#f8f9fa', borderRadius: '8px', marginBottom: '15px', alignItems: 'flex-end', flexWrap: 'wrap' as const },
  filterGroup: { display: 'flex', flexDirection: 'column' as const, gap: '3px' },
  label: { fontSize: '10px', color: '#666', fontWeight: 'bold' },
  input: { padding: '6px', borderRadius: '4px', border: '1px solid #ccc', fontSize: '11px' },
  divider: { width: '1px', height: '30px', backgroundColor: '#ddd' },
  btnSearch: { padding: '8px 12px', backgroundColor: '#636e72', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' },
  btnLoad: { padding: '8px 12px', backgroundColor: '#0984e3', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' },
  btnExcel: { padding: '8px 12px', backgroundColor: '#27ae60', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' },
  tableContainer: { border: '1px solid #eee' },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '11px' },
  th: { padding: '10px', borderBottom: '2px solid #eee', textAlign: 'left' as const },
  td: { padding: '8px', borderBottom: '1px solid #eee' },
  tdProject: { padding: '10px', fontWeight: 'bold', backgroundColor: '#fafafa', borderRight: '1px solid #eee', width: '25%' },
  tr: { verticalAlign: 'top' as const },
  loading: { textAlign: 'center' as const, marginTop: '100px', fontSize: '20px' },
  btnApprove: { padding: '3px 7px', backgroundColor: '#2ecc71', color: 'white', border: 'none', borderRadius: '3px', cursor: 'pointer', fontSize: '10px' }
};

export default App;