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
        <div className="w-screen h-screen bg-black text-white flex flex-col items-center justify-center p-8">
          <div className="bg-red-900/20 border border-red-500/30 p-8 rounded-3xl max-w-lg text-center backdrop-blur-lg">
            <AlertOctagon className="w-16 h-16 text-red-500 mx-auto mb-6" />
            <h1 className="text-3xl font-bold mb-4 brand-font">SYSTEM FAILURE</h1>
            <p className="text-gray-400 mb-6">
              An unexpected error occurred in the warp field.
              <br />
              <span className="text-xs text-red-400 mt-2 block font-mono bg-black/30 p-2 rounded">
                {this.state.error?.message}
              </span>
            </p>
            <button
              onClick={() => window.location.reload()}
              className="bg-white text-black px-8 py-3 rounded-full font-bold hover:bg-red-50 transition-colors flex items-center gap-2 mx-auto"
            >
              <RefreshCw size={18} />
              REBOOT SYSTEM
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
