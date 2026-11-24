import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import "./styles.css";

const monacoVsPath = new URL(
  import.meta.env.DEV
    ? "node_modules/monaco-editor/min/vs"
    : "../../../monaco/vs",
  document.baseURI,
).href;

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 15_000 } },
});

void Promise.all([import("@monaco-editor/react"), import("./App")]).then(([{ loader }, { default: App }]) => {
  loader.config({ paths: { vs: monacoVsPath } });
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <ConfigProvider
          locale={zhCN}
          theme={{
            token: {
              colorPrimary: "#2b7a6d",
              colorPrimaryHover: "#3d917f",
              colorPrimaryActive: "#216358",
              colorBgLayout: "#f4f6f8",
              colorBgContainer: "#ffffff",
              colorText: "#203044",
              colorTextSecondary: "#5d7080",
              colorTextTertiary: "#8998a6",
              colorBorder: "#dfe6ea",
              colorBorderSecondary: "#eaf0f2",
              borderRadius: 8,
              borderRadiusSM: 6,
              borderRadiusLG: 12,
              fontFamily: '"Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif',
              fontSize: 12,
              controlHeight: 34,
              controlHeightSM: 28,
              lineHeight: 1.55,
              boxShadowSecondary: "0 6px 20px #2030401f",
            },
            components: {
              Button: { primaryShadow: "0 2px 6px #2b7a6d33", fontWeight: 500 },
              Card: { headerFontSize: 13, paddingLG: 16 },
              Input: { activeShadow: "0 0 0 3px #2b7a6d1f" },
              Select: { optionSelectedBg: "#eaf4f1" },
              Table: {
                headerBg: "#f5f8f9",
                headerColor: "#526576",
                headerSplitColor: "transparent",
                rowHoverBg: "#f2f8f6",
                cellPaddingBlockSM: 7,
                cellPaddingInlineSM: 10,
                borderColor: "#e8eef1",
              },
              Tabs: { horizontalItemPadding: "10px 0", itemColor: "#657888" },
              Tooltip: { colorBgSpotlight: "#22354a" },
              Message: { contentPadding: "9px 14px" },
            },
          }}
        >
          <App />
        </ConfigProvider>
      </QueryClientProvider>
    </React.StrictMode>,
  );
}).catch((error: unknown) => {
  console.error("DB Studio renderer startup failed", error);
  const root = document.getElementById("root");
  if (root) root.textContent = "DB Studio 加载失败，请重启应用并检查安装文件。";
});