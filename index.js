import { registerRootComponent } from 'expo';
import App from './App';

if (typeof __DEV__ !== 'undefined' && __DEV__) {
  console.log('[Bidify/boot] index.js — registerRootComponent(App)');
}

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
