/**
 * Hardware-accelerated 3D Fluid Orb Shader.
 *
 * Implements the approved volumetric fluid shader from Google Stitch:
 * (Sanket Vaanni Standalone 3D Interactive Orb Component, screen fae1a784eed349cdb7648ba97c32b795)
 *
 * Runs self-contained WebGL inside an optimized transparent WebView on Android/iOS,
 * and passes the active theme colours and state activity through postMessage.
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

import type { OrbState } from './useOrbState';
import { useTheme } from '../../theme/ThemeProvider';
import { useReduceMotion } from '../../hooks/useReduceMotion';

const WebViewComponent = WebView as any;

export interface OrbShaderProps {
  state: OrbState;
  size: number;
  testID?: string;
}

/** Convert hex string '#10B981' to normalized [r, g, b] (0..1) */
function hexToRgbNormalized(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  if (clean.length === 3) {
    const r = parseInt(clean[0] + clean[0], 16) / 255;
    const g = parseInt(clean[1] + clean[1], 16) / 255;
    const b = parseInt(clean[2] + clean[2], 16) / 255;
    return [r, g, b];
  }
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;
  return [isNaN(r) ? 0.06 : r, isNaN(g) ? 0.86 : g, isNaN(b) ? 0.5 : b];
}

export function OrbShader({ state, size, testID }: OrbShaderProps): React.JSX.Element {
  const webViewRef = useRef<WebView>(null);
  const { palette } = useTheme();
  const reduceMotion = useReduceMotion();

  const [cr, cg, cb] = useMemo(() => hexToRgbNormalized(palette.accent), [palette.accent]);
  const [lr, lg, lb] = useMemo(() => hexToRgbNormalized(palette.accentSoft), [palette.accentSoft]);

  // Activity & speed parameters based on state
  const { speed, activity } = useMemo(() => {
    if (reduceMotion) return { speed: 0.0, activity: 0.2 };
    switch (state) {
      case 'idle':
        return { speed: 0.6, activity: 0.35 };
      case 'connecting':
        return { speed: 1.4, activity: 0.7 };
      case 'ready':
        return { speed: 0.8, activity: 0.5 };
      case 'receiving':
        return { speed: 1.8, activity: 0.85 };
      case 'recognising':
        return { speed: 2.2, activity: 0.95 };
      case 'text-updating':
        return { speed: 2.5, activity: 1.0 };
      case 'speaking':
        return { speed: 1.6, activity: 0.8 };
      case 'error':
        return { speed: 0.0, activity: 0.1 };
      default:
        return { speed: 0.8, activity: 0.5 };
    }
  }, [state, reduceMotion]);

  // Update shader uniforms whenever theme or state changes
  useEffect(() => {
    if (!webViewRef.current) return;
    const js = `window.setOrbParams && window.setOrbParams(${cr}, ${cg}, ${cb}, ${lr}, ${lg}, ${lb}, ${speed}, ${activity}); true;`;
    webViewRef.current.injectJavaScript(js);
  }, [cr, cg, cb, lr, lg, lb, speed, activity]);

  const html = useMemo(() => {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body, html { width: 100%; height: 100%; overflow: hidden; background: transparent; }
  canvas { display: block; width: 100%; height: 100%; border-radius: 50%; }
</style>
</head>
<body>
<canvas id="c"></canvas>
<script>
(function() {
  const canvas = document.getElementById('c');
  const gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: false });
  if (!gl) return;

  function resize() {
    canvas.width = canvas.clientWidth * window.devicePixelRatio || ${size * 2};
    canvas.height = canvas.clientHeight * window.devicePixelRatio || ${size * 2};
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  resize();

  const vsSource = \`
    attribute vec2 a_pos;
    varying vec2 v_uv;
    void main() {
      v_uv = a_pos * 0.5 + 0.5;
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  \`;

  const fsSource = \`
    precision mediump float;
    varying vec2 v_uv;
    uniform float u_time;
    uniform vec2 u_res;
    uniform vec3 u_color;
    uniform vec3 u_light;
    uniform float u_speed;
    uniform float u_act;

    // Simplex 3D noise
    vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec4 permute(vec4 x) { return mod289(((x*34.0)+1.0)*x); }
    vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

    float snoise(vec3 v) {
      const vec2 C = vec2(1.0/6.0, 1.0/3.0);
      const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
      vec3 i  = floor(v + dot(v, C.yyy));
      vec3 x0 = v - i + dot(i, C.xxx);
      vec3 g = step(x0.yzx, x0.xyz);
      vec3 l = 1.0 - g;
      vec3 i1 = min(g.xyz, l.zxy);
      vec3 i2 = max(g.xyz, l.zxy);
      vec3 x1 = x0 - i1 + C.xxx;
      vec3 x2 = x0 - i2 + C.yyy;
      vec3 x3 = x0 - D.yyy;
      i = mod289(i);
      vec4 p = permute(permute(permute(
                 i.z + vec4(0.0, i1.z, i2.z, 1.0))
               + i.y + vec4(0.0, i1.y, i2.y, 1.0))
               + i.x + vec4(0.0, i1.x, i2.x, 1.0));
      float n_ = 0.142857142857;
      vec3 ns = n_ * D.wyz - D.xzx;
      vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
      vec4 x_ = floor(j * ns.z);
      vec4 y_ = floor(j - 7.0 * x_);
      vec4 x = x_ *ns.x + ns.yyyy;
      vec4 y = y_ *ns.x + ns.yyyy;
      vec4 h = 1.0 - abs(x) - abs(y);
      vec4 b0 = vec4(x.xy, y.xy);
      vec4 b1 = vec4(x.zw, y.zw);
      vec4 s0 = floor(b0)*2.0 + 1.0;
      vec4 s1 = floor(b1)*2.0 + 1.0;
      vec4 sh = -step(h, vec4(0.0));
      vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
      vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
      vec3 p0 = vec3(a0.xy, h.x);
      vec3 p1 = vec3(a0.zw, h.y);
      vec3 p2 = vec3(a1.xy, h.z);
      vec3 p3 = vec3(a1.zw, h.w);
      vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
      p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
      vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
      m = m * m;
      return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
    }

    void main() {
      vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / min(u_res.x, u_res.y);
      float dist = length(uv);
      float r = 0.44;

      if (dist > r) {
        float edge = dist - r;
        float halo = exp(-edge * 14.0) * 0.45 * u_act;
        gl_FragColor = vec4(u_color * halo, clamp(halo, 0.0, 1.0));
        return;
      }

      float z = sqrt(max(0.001, r * r - dist * dist));
      vec3 n = normalize(vec3(uv, z));
      float fresnel = pow(1.0 - n.z, 2.2);

      vec3 p = vec3(uv * 3.2, z * 2.0 + u_time * u_speed * 0.5);
      float noise = snoise(p);
      float plasma = 0.5 + 0.5 * sin(noise * 3.5 + u_time * u_speed);

      vec3 coreCol = mix(u_color * 0.4, u_light, plasma * u_act);
      coreCol += u_light * fresnel * 0.7;

      gl_FragColor = vec4(coreCol, 0.96);
    }
  \`;

  function createShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  }

  const prog = gl.createProgram();
  gl.attachShader(prog, createShader(gl.VERTEX_SHADER, vsSource));
  gl.attachShader(prog, createShader(gl.FRAGMENT_SHADER, fsSource));
  gl.linkProgram(prog);
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);

  const posLoc = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  const uTime = gl.getUniformLocation(prog, 'u_time');
  const uRes = gl.getUniformLocation(prog, 'u_res');
  const uColor = gl.getUniformLocation(prog, 'u_color');
  const uLight = gl.getUniformLocation(prog, 'u_light');
  const uSpeed = gl.getUniformLocation(prog, 'u_speed');
  const uAct = gl.getUniformLocation(prog, 'u_act');

  let curCr = ${cr}, curCg = ${cg}, curCb = ${cb};
  let curLr = ${lr}, curLg = ${lg}, curLb = ${lb};
  let curSpeed = ${speed}, curAct = ${activity};

  window.setOrbParams = function(cr, cg, cb, lr, lg, lb, sp, ac) {
    curCr = cr; curCg = cg; curCb = cb;
    curLr = lr; curLg = lg; curLb = lb;
    curSpeed = sp; curAct = ac;
  };

  let t = 0;
  function render() {
    t += 0.016;
    gl.uniform1f(uTime, t);
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform3f(uColor, curCr, curCg, curCb);
    gl.uniform3f(uLight, curLr, curLg, curLb);
    gl.uniform1f(uSpeed, curSpeed);
    gl.uniform1f(uAct, curAct);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);
})();
</script>
</body>
</html>`;
  }, [size, cr, cg, cb, lr, lg, lb, speed, activity]);

  return (
    <View style={[styles.container, { width: size, height: size }]} testID={testID}>
      <WebViewComponent
        ref={webViewRef}
        originWhitelist={['*']}
        source={{ html }}
        style={styles.webview}
        androidLayerType="hardware"
        scrollEnabled={false}
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        overScrollMode="never"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 9999,
    overflow: 'hidden',
    backgroundColor: 'transparent',
  },
  webview: {
    width: '100%',
    height: '100%',
    backgroundColor: 'transparent',
  },
});
