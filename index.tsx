import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
// ✅ 개발 중에는 StrictMode 제거
root.render(<App />);

// 프로덕션에서는 StrictMode 사용
// root.render(
//   <React.StrictMode>
//     <App />
//   </React.StrictMode>
// );