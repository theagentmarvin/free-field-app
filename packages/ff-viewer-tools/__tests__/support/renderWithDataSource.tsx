// packages/ff-viewer-tools/__tests__/support/renderWithDataSource.tsx
//
// Test helpers that wrap `renderHook` / `render` in a
// <ViewerToolsProvider> backed by the Dexie test double. Use these in
// any package test that exercises a hook/component consuming
// `useViewerToolsDataSource()`.

import type { ReactNode } from "react";
import {
  render,
  renderHook,
  type RenderHookOptions,
  type RenderOptions,
} from "@testing-library/react";

import {
  ViewerToolsProvider,
  type ViewerToolsDataSource,
} from "../../src/dataSource";
import { testDataSource } from "./testDb";

function makeWrapper(dataSource: ViewerToolsDataSource) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <ViewerToolsProvider dataSource={dataSource}>
        {children}
      </ViewerToolsProvider>
    );
  };
}

/** `renderHook` with the test data source injected via context. */
export function renderHookWithDataSource<Result, Props>(
  hook: (initialProps: Props) => Result,
  options?: Omit<RenderHookOptions<Props>, "wrapper"> & {
    dataSource?: ViewerToolsDataSource;
  },
) {
  const { dataSource = testDataSource, ...rest } = options ?? {};
  return renderHook(hook, { wrapper: makeWrapper(dataSource), ...rest });
}

/** `render` with the test data source injected via context. */
export function renderWithDataSource(
  ui: React.ReactElement,
  options?: Omit<RenderOptions, "wrapper"> & {
    dataSource?: ViewerToolsDataSource;
  },
) {
  const { dataSource = testDataSource, ...rest } = options ?? {};
  return render(ui, { wrapper: makeWrapper(dataSource), ...rest });
}
