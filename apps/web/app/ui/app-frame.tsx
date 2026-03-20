"use client";

import { AppstoreOutlined, ConsoleSqlOutlined, FundProjectionScreenOutlined, HomeOutlined, SettingOutlined } from "@ant-design/icons";
import { Grid, Layout, Menu } from "antd";
import type { MenuProps } from "antd";
import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS: MenuProps["items"] = [
  { key: "/", icon: <HomeOutlined />, label: <Link href="/">首页</Link> },
  { key: "/market", icon: <FundProjectionScreenOutlined />, label: <Link href="/market">市场趋势</Link> },
  { key: "/genres", icon: <AppstoreOutlined />, label: <Link href="/genres">题材库</Link> },
  { key: "/settings", icon: <SettingOutlined />, label: <Link href="/settings">设置</Link> },
  { key: "/commands", icon: <ConsoleSqlOutlined />, label: <Link href="/commands">高级工具</Link> },
];

function selectedKey(pathname: string): string {
  if (pathname.startsWith("/market")) return "/market";
  if (pathname.startsWith("/genres")) return "/genres";
  if (pathname.startsWith("/settings") || pathname.startsWith("/setup")) return "/settings";
  if (pathname.startsWith("/commands")) return "/commands";
  return "/";
}

export function AppFrame({ children }: Readonly<{ children: React.ReactNode }>) {
  const pathname = usePathname();
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;

  return (
    <Layout style={{ minHeight: "100vh", background: "transparent" }}>
      <Layout.Header
        style={{
          display: "flex",
          flexDirection: isMobile ? "column" : "row",
          alignItems: isMobile ? "stretch" : "center",
          background: "linear-gradient(180deg, rgba(10,18,24,0.96) 0%, rgba(14,24,30,0.9) 100%)",
          borderBottom: "1px solid rgba(182, 201, 198, 0.12)",
          boxShadow: "0 10px 30px rgba(6, 12, 18, 0.22)",
          backdropFilter: "blur(14px)",
          padding: isMobile ? "10px 12px 0" : "0 24px",
          height: isMobile ? "auto" : 72,
          lineHeight: isMobile ? "normal" : undefined,
        }}
      >
        <div style={{ color: "#ecf3f1", fontWeight: 700, marginRight: isMobile ? 0 : 24, marginBottom: isMobile ? 6 : 0, display: "flex", flexDirection: "column", justifyContent: isMobile ? "center" : "center", gap: 0, paddingTop: isMobile ? 0 : 6, paddingBottom: isMobile ? 0 : 2, minHeight: isMobile ? 28 : undefined }}>
          <span style={{ fontSize: isMobile ? 16 : 18, letterSpacing: "0.08em", lineHeight: 1.1 }}>InkOS · 诛仙卷</span>
          {!isMobile ? <span style={{ fontSize: 11, color: "rgba(197, 214, 211, 0.72)", fontWeight: 500, lineHeight: 1.1, marginTop: 2 }}>云深夜冷，卷页藏锋</span> : null}
        </div>
        <Menu
          mode="horizontal"
          selectedKeys={[selectedKey(pathname)]}
          items={NAV_ITEMS}
          style={{ flex: 1, minWidth: 0, background: "transparent", borderBottom: "none", overflowX: "auto", whiteSpace: "nowrap", marginTop: isMobile ? 0 : undefined }}
          theme="dark"
        />
      </Layout.Header>
      <Layout.Content style={{ padding: isMobile ? 12 : 24 }}>
        <div style={{ maxWidth: 1300, margin: "0 auto" }}>{children}</div>
      </Layout.Content>
    </Layout>
  );
}
