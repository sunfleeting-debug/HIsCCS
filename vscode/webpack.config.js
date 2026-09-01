//@ts-check

'use strict';

const path = require('path');
// @ts-ignore
const WebpackObfuscator = require('webpack-obfuscator');

//@ts-check
/** @typedef {import('webpack').Configuration} WebpackConfig **/

/** @type WebpackConfig */
const extensionConfig = {
  target: 'node',
	mode: 'none',

  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2'
  },
  externals: {
    vscode: 'commonjs vscode'
  },
  resolve: {
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [{ loader: 'ts-loader' }]
      }
    ]
  },
  plugins: [
    new WebpackObfuscator({
      // 字符串数组混淆
      stringArray: true,
      stringArrayThreshold: 1.0,
      stringArrayEncoding: ['rc4'],
      stringArrayRotateLoop: 3,
      stringArrayWrappersCount: 4,
      stringArrayWrappersChainedCalls: true,
      stringArrayWrappersType: 'variable',
      stringArrayWrappersBulkCount: 30,
      // 随机变量名
      rotateStringArray: true,
      identifierNamesGenerator: 'mangled',
      // 控制流扁平化（强保护）
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 0.75,
      deadCodeInjection: true,
      deadCodeInjectionThreshold: 0.4,
      // 调试防护
      selfDefending: true,
      // 数字编码
      numbersToExpressions: true,
      // 简化模式关闭（最大化混淆）
      simplify: false,
      // 源码地图禁用
      sourceMap: false,
      // 额外配置
      debugProtection: false,
      compact: true,
    }, [])
  ],
  devtool: false,
  infrastructureLogging: {
    level: "error",
  },
};
module.exports = [ extensionConfig ];
