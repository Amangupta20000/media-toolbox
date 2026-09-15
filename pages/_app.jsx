import "../styles/globals.css";
import { SeoHead } from "../components/seo-head.jsx";

export default function App({ Component, pageProps }) {
  return <>
    <SeoHead />
    <Component {...pageProps} />
  </>;
}
