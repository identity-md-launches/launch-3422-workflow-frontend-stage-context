import { StrictMode, useMemo, useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { loadDeployment, type Deployment } from "./deployment";
import { makeWagmiConfig } from "./wallet";
import { App } from "./App";
import "./styles.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

function Root() {
  const [d, setD] = useState<Deployment>();
  const [err, setErr] = useState<string>();
  useEffect(() => {
    loadDeployment().then(setD, (e: Error) => setErr(e.message));
  }, []);
  const config = useMemo(() => (d ? makeWagmiConfig(d) : undefined), [d]);
  if (err)
    return (
      <main className="boot" id="main">
        <h1>test staking</h1>
        <p className="note note-error" role="alert">The deployment configuration did not load: {err}. Reload the page to try again.</p>
      </main>
    );
  if (!d || !config)
    return (
      <main className="boot" id="main">
        <p role="status">Loading deployment…</p>
      </main>
    );
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <App d={d} />
      </QueryClientProvider>
    </WagmiProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
