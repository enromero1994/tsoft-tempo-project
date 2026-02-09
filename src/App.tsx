import React, { useEffect, useState } from 'react';
import * as XLSX from 'xlsx';

// --- CONFIGURACIÓN PROTEGIDA (Vite) ---
// En Vite se usa import.meta.env en lugar de process.env
const TEMPO_TOKEN = import.meta.env.VITE_TEMPO_TOKEN || '';
const JIRA_USER = import.meta.env.VITE_APP_JIRA_USER || '';
const JIRA_PASS = import.meta.env.VITE_APP_JIRA_PASS || '';

const JIRA_AUTH = (JIRA_USER && JIRA_PASS)
  ? 'Basic ' + btoa(`${JIRA_USER}:${JIRA_PASS}`)
  : '';

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

  // Filtros
  const [dateFrom, setDateFrom] = useState(new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0]);
  const [dateTo, setDateTo] = useState(new Date().toISOString().split('T')[0]);
  const [projectSearch, setProjectSearch] = useState('');
  const [userSearch, setUserSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('ALL');
  const [filterType, setFilterType] = useState('ALL');
  const [viewMode, setViewMode] = useState('ONLY_DATA');

  useEffect(() => {
    // Verificación de seguridad básica
    if (!TEMPO_TOKEN || !JIRA_AUTH) {
      console.error("Faltan configurar las variables de entorno en el archivo .env");
      setInitialLoad(false);
      return;
    }

    const fetchFullProjectList = async () => {
      try {
        let allItems: any[] = [];
        let offset = 0;
        let hasMore = true;
        while (hasMore) {
          const res = await fetch(`${BASE_URL_TEMPO}/projects?offset=${offset}&limit=100`, {
            headers: { Authorization: `Bearer ${TEMPO_TOKEN}` }
          });
          const json = await res.json();
          if (json.results && json.results.length > 0) {
            const processed = json.results.map((p: any) => ({ id: p.id, key: p.key, name: p.name }));
            allItems = [...allItems, ...processed];
            if (json.metadata && json.metadata.next) offset += 100;
            else hasMore = false;
          } else hasMore = false;
        }
        setAllProjectList(allItems);
      } catch (e) { console.error("Error inicial:", e); }
      finally { setInitialLoad(false); }
    };
    fetchFullProjectList();
  }, []);

  const fetchJiraName = async (selfUrl: string, accountId: string) => {
    if (userCache[accountId]) return userCache[accountId];
    try {
      const proxyUrl = selfUrl.replace('https://ayudatsoft.atlassian.net', BASE_URL_JIRA);
      const res = await fetch(proxyUrl, { headers: { 'Authorization': JIRA_AUTH, 'Accept': 'application/json' } });
      if (res.ok) {
        const data = await res.json();
        userCache[accountId] = data.displayName;
        return data.displayName;
      }
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
      setLoadingMessage(`Procesando ${absoluteIndex} de ${allProjectList.length}: ${project.name}...`);

      try {
        await delay(250);
        const res = await fetch(`${BASE_URL_TEMPO}/projects/${project.id}/time-approvals?from=${dateFrom}&to=${dateTo}`, {
          headers: { Authorization: `Bearer ${TEMPO_TOKEN}` }
        });

        if (!res.ok) {
          if (res.status === 429) console.warn(`⚠️ [429] Rate Limit en: ${project.name}`);
          else if (res.status === 403) console.error(`🚫 [403] Sin permisos en: ${project.name}`);

          setDisplayData(prev => [...prev, { id: project.id, projectName: project.name || project.key, approvals: [] }]);
          setCurrentIndex(absoluteIndex);
          continue;
        }

        const json = await res.json();
        const enriched = await Promise.all((json.results || []).map(async (auth: any) => {
          const name = await fetchJiraName(auth.user?.userLink?.linked?.self || '', auth.user.id);
          return { ...auth, userName: name };
        }));

        setDisplayData(prev => [...prev, { id: project.id, projectName: project.name || project.key, approvals: enriched }]);
        setCurrentIndex(absoluteIndex);
      } catch (e) {
        console.error(`❌ Error de red en ${project.name}:`, e);
        setDisplayData(prev => [...prev, { id: project.id, projectName: project.name, approvals: [] }]);
      }
    }
    setLoading(false);
    setLoadingMessage('');
  };

  const approveHours = async (projectId: string, from: string, to: string, accountId: string, userName: string) => {
    if (!window.confirm(`¿Aprobar horas de ${userName}?`)) return;
    try {
      const res = await fetch(`${BASE_URL_TEMPO}/projects/${projectId}/time-approvals/approve`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${TEMPO_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          teamMemberIds: [accountId],
          period: { from, to },
          comment: "Aprobado mediante Panel Tsoft"
        })
      });

      if (res.ok) {
        alert(`✅ ¡Horas de ${userName} aprobadas!`);
        setDisplayData(prev => prev.map(p => p.id === projectId ? {
          ...p,
          approvals: p.approvals.map((a: any) =>
            a.user.id === accountId ? { ...a, status: { key: 'APPROVED' } } : a
          )
        } : p));
      } else {
        const errorData = await res.json();
        alert(`❌ Error: ${errorData.errors?.[0]?.message || 'No se pudo aprobar'}`);
      }
    } catch (e) {
      alert("❌ Error de red");
    }
  };

  const exportToExcel = () => {
    const rows = filteredData.flatMap(p => p.approvals.map(a => ({
      Proyecto: p.projectName,
      Colaborador: a.userName,
      Estado: a.status.key,
      Horas: (a.timeSpentSeconds / 3600).toFixed(2),
      Desde: a.period.from,
      Hasta: a.period.to
    })));

    if (rows.length === 0) {
      alert("⚠️ No hay datos para exportar.");
      return;
    }

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Aprobaciones");
    XLSX.writeFile(wb, `Control_Tempo_${dateFrom}.xlsx`);
  };

  const filteredData = displayData.map(proj => ({
    ...proj,
    approvals: proj.approvals.filter(auth => {
      const matchesStatus = filterStatus === 'ALL' || auth.status.key === filterStatus;
      const matchesUser = (auth.userName || '').toLowerCase().includes(userSearch.toLowerCase());
      return matchesStatus && matchesUser;
    })
  })).filter(proj => {
    const matchesName = proj.projectName.toLowerCase().includes(projectSearch.toLowerCase());
    let matchesType = true;
    if (filterType === 'PROY') matchesType = proj.projectName.toUpperCase().startsWith('PROY');
    if (filterType === 'PREV') matchesType = proj.projectName.toUpperCase().startsWith('PREV');

    const hasData = proj.approvals.length > 0;
    const matchesView = viewMode === 'ALL' || hasData;

    return matchesName && matchesType && matchesView;
  });

  if (initialLoad) return <div style={s.loading}>Sincronizando Proyectos...</div>;

  return (
    <div style={s.container}>
      <div style={s.header}>
        <h1 style={s.title}>Control Tsoft</h1>
        <div style={{ display: 'flex', gap: '10px' }}>
          {currentIndex < allProjectList.length && (
            <button onClick={loadAllRemaining} disabled={loading} style={s.btnLoad}>
              {loading ? `⏳ ${loadingMessage}` : `🚀 Cargar Pendientes (${allProjectList.length - currentIndex})`}
            </button>
          )}
          <button onClick={exportToExcel} style={s.btnExcel}>Excel 📥</button>
        </div>
      </div>

      <div style={s.filterBar}>
        <div style={s.filterGroup}><label style={s.label}>Desde:</label>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={s.input} />
        </div>
        <div style={s.filterGroup}><label style={s.label}>Hasta:</label>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={s.input} />
        </div>
        <button onClick={() => { setDisplayData([]); setCurrentIndex(0); }} style={s.btnSearch}>🔍 Reiniciar</button>
        <div style={s.divider} />

        <div style={s.filterGroup}><label style={s.label}>Tipo:</label>
          <select value={filterType} onChange={e => setFilterType(e.target.value)} style={s.input}>
            <option value="ALL">Todos</option>
            <option value="PROY">PROY</option>
            <option value="PREV">PREV</option>
          </select>
        </div>

        <div style={s.filterGroup}><label style={s.label}>Estado:</label>
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={s.input}>
            <option value="ALL">Todos los Estados</option>
            <option value="APPROVED">APPROVED</option>
            <option value="IN_REVIEW">IN_REVIEW</option>
            <option value="OPEN">OPEN</option>
          </select>
        </div>

        <div style={s.filterGroup}><label style={s.label}>Mostrar:</label>
          <select value={viewMode} onChange={e => setViewMode(e.target.value)} style={{ ...s.input, backgroundColor: '#fff3cd', fontWeight: 'bold' }}>
            <option value="ONLY_DATA">Solo con registros</option>
            <option value="ALL">Ver todos los proyectos</option>
          </select>
        </div>

        <input type="text" placeholder="Proyecto..." value={projectSearch} onChange={e => setProjectSearch(e.target.value)} style={s.input} />
        <input type="text" placeholder="Colaborador..." value={userSearch} onChange={e => setUserSearch(e.target.value)} style={s.input} />
      </div>

      <div style={s.tableContainer}>
        <table style={s.table}>
          <thead>
            <tr style={{ backgroundColor: '#f1f2f6' }}>
              <th style={s.th}>Proyecto</th>
              <th style={s.th}>Colaborador</th>
              <th style={s.th}>Estado</th>
              <th style={s.th}>Horas</th>
              <th style={s.th}>Periodo</th>
            </tr>
          </thead>
          <tbody>
            {filteredData.map((proj, i) => (
              proj.approvals.length > 0 ? (
                proj.approvals.map((auth, j) => (
                  <tr key={`${i}-${j}`} style={s.tr}>
                    {j === 0 && <td rowSpan={proj.approvals.length} style={s.tdProject}>{proj.projectName}</td>}
                    <td style={s.td}>{auth.userName}</td>
                    <td style={s.td}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '5px' }}>
                        <span style={{ color: auth.status.key === 'APPROVED' ? '#27ae60' : '#e67e22', fontWeight: 'bold' }}>{auth.status.key}</span>
                        {auth.status.key !== 'APPROVED' && (
                          <button onClick={() => approveHours(proj.id, auth.period.from, auth.period.to, auth.user.id, auth.userName)} style={s.btnApprove}>✅</button>
                        )}
                      </div>
                    </td>
                    <td style={s.td}>{(auth.timeSpentSeconds / 3600).toFixed(2)}h</td>
                    <td style={s.td}>{auth.period.from} / {auth.period.to}</td>
                  </tr>
                ))
              ) : (
                <tr key={`empty-${i}`} style={{ ...s.tr, backgroundColor: '#fdfdfd' }}>
                  <td style={{ ...s.tdProject, color: '#999' }}>{proj.projectName}</td>
                  <td colSpan={4} style={{ ...s.td, color: '#ccc', fontStyle: 'italic' }}>Sin registros en este periodo</td>
                </tr>
              )
            ))}
          </tbody>
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