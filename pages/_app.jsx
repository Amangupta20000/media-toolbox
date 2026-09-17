import "../styles/globals.css";
import { AnalyticsRuntime } from "../components/analytics.jsx";
import { SeoHead } from "../components/seo-head.jsx";

export default function App({ Component, pageProps }) {
  return <>
    <AnalyticsRuntime />
    <SeoHead />
    <Component {...pageProps} />
  </>;
}
