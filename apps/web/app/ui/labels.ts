export function labelGenre(genre: string): string {
  switch (genre) {
    case "xuanhuan":
      return "玄幻";
    case "xianxia":
      return "仙侠";
    case "chuanyue":
      return "穿越";
    case "urban":
      return "都市";
    case "horror":
      return "恐怖";
    case "other":
      return "其他";
    default:
      return genre;
  }
}

export function labelPlatform(platform: string): string {
  switch (platform) {
    case "tomato":
      return "番茄";
    case "feilu":
      return "飞卢";
    case "qidian":
      return "起点";
    case "other":
      return "其他";
    default:
      return platform;
  }
}

export function labelBookStatus(status: string): string {
  switch (status) {
    case "incubating":
      return "孵化中";
    case "outlining":
      return "大纲中";
    case "active":
      return "进行中";
    case "paused":
      return "暂停";
    case "completed":
      return "已完结";
    case "dropped":
      return "已弃坑";
    default:
      return status;
  }
}
