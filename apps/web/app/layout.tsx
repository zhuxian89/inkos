import type { Metadata } from "next";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import { App, ConfigProvider, theme } from "antd";
import "./globals.css";
import { AppFrame } from "./ui/app-frame";

export const metadata: Metadata = {
  title: "InkOS · 诛仙卷",
  description: "诛仙气质的 InkOS 小说工作台",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <AntdRegistry>
          <ConfigProvider
            theme={{
              algorithm: theme.defaultAlgorithm,
              token: {
                colorPrimary: "#5f8f8a",
                colorInfo: "#5f8f8a",
                colorSuccess: "#7aa27a",
                colorWarning: "#c79a62",
                colorError: "#b86b6b",
                borderRadius: 12,
                boxShadowSecondary: "0 18px 44px rgba(10, 18, 24, 0.14)",
              },
            }}
          >
            <App>
              <AppFrame>{children}</AppFrame>
            </App>
          </ConfigProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
