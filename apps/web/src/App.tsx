import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { queryClient } from "@/app/query-client";
import { AppRoutes } from "@/app/routes";
import "./index.css";

// App is composed from providers/routes in src/app and feature UI in src/components + src/pages.
// QueryClient initialization lives in src/app/query-client.ts.
// Route tree lives in src/app/routes.tsx.
export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppRoutes />
      <Toaster richColors closeButton position="top-right" />
    </QueryClientProvider>
  );
}

export default App;
