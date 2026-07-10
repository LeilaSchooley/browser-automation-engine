function timestamp() {
  return new Date().toISOString();
}

function formatLine(layer, message) {
  const tag = layer ? `[${layer}] ` : "";
  return `${tag}${message}`;
}

/**
 * Console logger compatible with the apply pipeline layers.
 * @param {{ sessionId?: string, label?: string, onStep?: (phase: string, message: string) => void }} [opts]
 */
export function createLogger({ sessionId = null, label = "engine", onStep = null } = {}) {
  const prefix = sessionId ? `[${label}:${sessionId}]` : `[${label}]`;

  const write = (level, message, layer = null) => {
    const body = formatLine(layer, message);
    console.log(`${prefix} ${body}`);
  };

  return {
    info: (msg, layer) => write("info", msg, layer),
    warn: (msg, layer) => write("warn", msg, layer),
    error: (msg, layer) => write("error", msg, layer),
    debug: (msg, layer) => write("debug", msg, layer),
    layer: (layerName, message, level = "debug") => write(level, message, layerName),
    step: (phase, message) => {
      onStep?.(phase, message);
      write("info", message, phase);
    },
  };
}
