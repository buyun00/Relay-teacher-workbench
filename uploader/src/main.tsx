import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./chat.css";
import "./theme.css";
import "katex/dist/katex.min.css";

function ReadyApp() {
  React.useEffect(() => { void window.classroom?.runtimeReady(); }, []);
  return <App />;
}
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ReadyApp />
  </React.StrictMode>,
);
