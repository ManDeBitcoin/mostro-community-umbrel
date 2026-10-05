import { useEffect, useState } from 'react';
import type { SimulationReport, SimulationScenarioInfo } from '../types';
import { api } from '../lib/api';

/** The simulator's inputs and last result, kept while the operator looks at other pages. */
export function useSimulator() {
  const [simScenarios, setSimScenarios] = useState<SimulationScenarioInfo[]>([]);
  const [selectedScenario, setSelectedScenario] = useState('happy_path');
  const [simSatsInput, setSimSatsInput] = useState('50000');
  const [simulating, setSimulating] = useState(false);
  const [simulationReport, setSimulationReport] = useState<SimulationReport | null>(null);
  const [simError, setSimError] = useState('');

  useEffect(() => {
    let alive = true;
    api<SimulationScenarioInfo[]>('/api/simulation/scenarios')
      .then((data) => { if (alive) setSimScenarios(data); })
      .catch(() => { if (alive) setSimScenarios([]); });
    return () => { alive = false; };
  }, []);

  const handleRunSimulation = async (scenarioOverride?: string) => {
    setSimulating(true);
    setSimError('');
    const targetScenario = scenarioOverride || selectedScenario;
    const sats = Number(simSatsInput) || 50000;
    try {
      const report = await api<SimulationReport>('/api/simulation/run', {
        method: 'POST',
        body: JSON.stringify({
          scenario: targetScenario,
          trade_sats: sats,
        }),
      });
      setSimulationReport(report);
    } catch (err) {
      setSimError(err instanceof Error ? err.message : 'Error al ejecutar la simulación');
    } finally {
      setSimulating(false);
    }
  };

  return { simScenarios, selectedScenario, setSelectedScenario, simSatsInput, setSimSatsInput, simulating, simulationReport, simError, handleRunSimulation };
}

export type Simulator = ReturnType<typeof useSimulator>;
