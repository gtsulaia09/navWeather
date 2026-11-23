/**
 * React Native entry point for iOS and Android (ADR-010).
 * Register `registerNativePlatform(...)` with your native modules before rendering `<App />`.
 */
import { AppRegistry } from 'react-native';
import { name as appName } from './app.json';
import { App } from './src/App';

AppRegistry.registerComponent(appName, () => App);
