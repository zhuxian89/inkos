import type { Metadata } from "next";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import { App, ConfigProvider, theme } from "antd";
import "./globals.css";
import { AppFrame } from "./ui/app-frame";

export const metadata: Metadata = {
  title: "InkOS Web Console",
  description: "Web console for InkOS CLI and project orchestration",
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
                colorPrimary: "#1677ff",
                borderRadius: 10,
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
