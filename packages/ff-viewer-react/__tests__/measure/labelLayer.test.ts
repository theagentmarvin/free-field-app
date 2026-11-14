import { describe, expect, it, vi } from "vitest";
import {
  MEASURE_LAYER_CLASS,
  gateLabelLayer,
  isMeasureLayerNeeded,
} from "../../src/measure/labelLayer";

function fakeLayer() {
  const classes: string[] = [];
  const render = vi.fn();
  return {
    layer: { render, domElement: { classList: { add: (c: string) => classes.push(c) } } },
    render,
    classes,
  };
}

describe("gateLabelLayer (wave 67: CSS2D layer cost gate)", () => {
  it("does not forward renders while no measurement is needed", () => {
    const { layer, render } = fakeLayer();
    gateLabelLayer(layer, () => false);
    for (let i = 0; i < 5; i++) layer.render({}, {});
    expect(render).not.toHaveBeenCalled();
  });

  it("forwards while needed and does ONE closing pass afterwards", () => {
    const { layer, render } = fakeLayer();
    let needed = true;
    gateLabelLayer(layer, () => needed);
    layer.render({}, {});
    layer.render({}, {});
    expect(render).toHaveBeenCalledTimes(2);
    needed = false;
    layer.render({}, {}); // closing pass hides stale labels
    layer.render({}, {});
    layer.render({}, {});
    expect(render).toHaveBeenCalledTimes(3);
  });

  it("tags the layer root and fails towards drawing when the probe throws", () => {
    const { layer, render, classes } = fakeLayer();
    gateLabelLayer(layer, () => {
      throw new Error("boom");
    });
    layer.render({}, {});
    expect(classes).toContain(MEASURE_LAYER_CLASS);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("dispose restores the original render", () => {
    const { layer, render } = fakeLayer();
    const gate = gateLabelLayer(layer, () => false);
    gate.dispose();
    layer.render({}, {});
    expect(render).toHaveBeenCalledTimes(1);
  });
});

describe("isMeasureLayerNeeded", () => {
  it("is true when armed or holding measurements, else false", () => {
    expect(isMeasureLayerNeeded([])).toBe(false);
    expect(isMeasureLayerNeeded([{ enabled: false, list: { size: 0 } }])).toBe(false);
    expect(isMeasureLayerNeeded([{ enabled: true }])).toBe(true);
    expect(isMeasureLayerNeeded([{ enabled: false, list: { size: 2 } }])).toBe(true);
  });
});
