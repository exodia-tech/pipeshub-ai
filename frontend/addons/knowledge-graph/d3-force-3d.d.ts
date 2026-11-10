declare module 'd3-force-3d' {
  export * from 'd3-force';
  import type { Simulation, SimulationNodeDatum } from 'd3-force';
  export function forceSimulation<N extends SimulationNodeDatum>(nodes: N[], dimensions: 3): Simulation<N, undefined>;
}
