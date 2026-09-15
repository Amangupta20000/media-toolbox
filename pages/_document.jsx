import { Head, Html, Main, NextScript } from "next/document";

export default function Document() {
  return <Html lang="en">
    <Head>
      <meta name="theme-color" content="#102034" />
      <meta name="color-scheme" content="light dark" />
      <meta name="format-detection" content="telephone=no" />
      <script dangerouslySetInnerHTML={{ __html: `try { document.documentElement.dataset.theme = window.localStorage.getItem("media-toolbox-theme") === "light" ? "light" : "dark"; } catch { document.documentElement.dataset.theme = "dark"; }` }} />
    </Head>
    <body>
      <Main />
      <NextScript />
    </body>
  </Html>;
}
