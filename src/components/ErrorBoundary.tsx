import React, { Component, ErrorInfo, ReactNode } from 'react';
import { RefreshCw, AlertOctagon } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-dvh w-full bg-[#071016] text-white flex flex-col items-center justify-center p-8">
          <div className="bg-slate-950/70 border border-red-400/25 p-8 rounded-3xl max-w-lg text-center backdrop-blur-lg shadow-[0_28px_90px_rgba(2,12,18,0.48)]">
            <AlertOctagon className="w-16 h-16 text-red-300 mx-auto mb-6" />
            <h1 className="text-3xl font-bold mb-4 brand-font">
              Something went wrong
            </h1>
            <p className="text-slate-300 mb-6">
              We could not keep the transfer interface running.
              <br />
              <span className="text-xs text-red-200 mt-2 block font-mono bg-black/30 p-2 rounded">
                {this.state.error?.message}
              </span>
            </p>
            <button
              onClick={() => window.location.reload()}
              className="bg-white text-slate-950 px-8 py-3 rounded-2xl font-semibold hover:bg-cyan-100 transition-colors flex items-center gap-2 mx-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200"
            >
              <RefreshCw size={18} />
              Reload
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
