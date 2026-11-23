import React, { useEffect, useMemo, useState } from 'react';
import { AppState, Button, PermissionsAndroid, Platform, Switch, Text, TextInput, View } from 'react-native';
import { connect } from './call';
import { createCallController, type CallState } from './session';

const label: Record<CallState, string> = {
  idle: 'Desconectado', connecting: 'Conectando…', connected: 'En conversación',
  error: 'Sesión finalizada. Revisá el permiso, los auriculares y la conexión. Para volver a hablar, abrí otro emisor.'
};
export default function App() {
  const [state, setState] = useState<CallState>('idle');
  const [pin, setPin] = useState('');
  const [bluetooth, setBluetooth] = useState(false);
  const call = useMemo(() => createCallController(setState), []);
  useEffect(() => {
    const listener = AppState.addEventListener('change', next => { if (next !== 'active') call.stop(); });
    return () => { listener.remove(); call.stop(); };
  }, [call]);
  const active = state === 'connected' || state === 'connecting';
  function start() {
    const code = pin;
    setPin('');
    void call.start(async scope => {
      const permissions = [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] as Parameters<typeof PermissionsAndroid.requestMultiple>[0];
      if (bluetooth && Number(Platform.Version) >= 31) permissions.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
      const granted = await PermissionsAndroid.requestMultiple(permissions);
      if (scope.signal.aborted) return;
      if (AppState.currentState !== 'active' || permissions.some(key => granted[key] !== 'granted')) throw new Error();
      await connect(scope, code, bluetooth);
    });
  }
  return <View style={{ flex: 1, justifyContent: 'center', padding: 32, gap: 14 }}>
    <Text accessibilityRole="header" style={{ fontSize: 30 }}>Atlas Companion</Text>
    <Text accessibilityLiveRegion="polite">{label[state]}</Text>
    <Text>Código de un solo uso del emisor USB</Text>
    <TextInput accessibilityLabel="Código del emisor" secureTextEntry keyboardType="number-pad"
      maxLength={8} value={pin} onChangeText={setPin} editable={!active} autoComplete="off" />
    <Text>Usar auriculares Bluetooth emparejados</Text>
    <Switch accessibilityLabel="Usar auriculares Bluetooth" disabled={active} value={bluetooth} onValueChange={setBluetooth} />
    {active ? <Button title="Finalizar" onPress={() => call.stop()} /> :
      <Button title="Hablar con Atlas" disabled={!/^\d{8}$/.test(pin)} onPress={start} />}
  </View>;
}
