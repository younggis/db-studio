import { describe, expect, it } from "vitest";
import { groupTablesByParent } from "./tree-partition";

describe("object tree partition folding", () => {
  const tables = [
    { key: "c:orders", title: "orders", parentName: null },
    { key: "c:orders_2024", title: "orders_2024", parentName: "public.orders" },
    { key: "c:orders_2025", title: "orders_2025", parentName: "public.orders" },
    { key: "c:users", title: "users" },
  ];

  it("folds partition children under their parent table", () => {
    const grouped = groupTablesByParent(tables);
    expect(grouped.map((group) => group.title)).toEqual(["orders", "users"]);
    expect(grouped[0].partitions.map((child) => child.title)).toEqual(["orders_2024", "orders_2025"]);
    expect(grouped[1].partitions).toEqual([]);
  });

  it("keeps every table key and order intact", () => {
    const grouped = groupTablesByParent(tables);
    expect(grouped.map((group) => group.key)).toEqual(["c:orders", "c:users"]);
    expect(grouped[0].partitions.map((child) => child.key))
      .toEqual(["c:orders_2024", "c:orders_2025"]);
  });

  it("is a no-op when there are no partitions", () => {
    const plain = [{ key: "c:users", title: "users" }, { key: "c:logs", title: "logs" }];
    const grouped = groupTablesByParent(plain);
    expect(grouped.map((group) => group.title)).toEqual(["users", "logs"]);
    expect(grouped.every((group) => group.partitions.length === 0)).toBe(true);
  });
});
