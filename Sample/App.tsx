/**
 * OmniDebugLink React Native Sample — 常用控件大杂烩
 *
 * 顶部：SDK 连接配置（token 输入 + 连接/断开 + actionsEnabled 开关 + 状态）
 * 下方：RN 常用控件各一区，供 ui_traverse / find_objects / ui_click /
 *       input_text / send_key / screenshot 等远程调试 task 练手。
 */
import React, {useCallback, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  Button,
  Dimensions,
  FlatList,
  Image,
  Modal,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableHighlight,
  TouchableOpacity,
  View,
} from 'react-native';
import {OmniDebugLink} from '@omnidebuglink/react-native';

const odl = new OmniDebugLink({
  onLog: (msg) => console.log('[ODL]', msg),
  onStateChange: (connected) => console.log('[ODL] connected:', connected),
});

const DATA = Array.from({length: 20}, (_, i) => ({
  id: `item-${i}`,
  title: `列表项 ${i + 1}`,
}));

export default function App(): React.JSX.Element {
  const [token, setToken] = useState('');
  const [connected, setConnected] = useState(false);
  const [actionsEnabled, setActionsEnabled] = useState(true);

  // 各控件状态 —— AI 远程操作的靶子
  const [controlledText, setControlledText] = useState('受控输入的初始值');
  const [uncontrolledText, setUncontrolledText] = useState('');
  const [switchValue, setSwitchValue] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [pressCount, setPressCount] = useState(0);
  const [touchOpacityCount, setTouchOpacityCount] = useState(0);
  const [highlightCount, setHighlightCount] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [lastTapped, setLastTapped] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const onStart = useCallback(() => {
    if (!token.trim()) {
      Alert.alert('缺少 token', '在输入框里填设备 clientToken（控制台获取）');
      return;
    }
    odl.setActionsEnabled(actionsEnabled);
    odl.start(token.trim());
    setConnected(true);
  }, [token, actionsEnabled]);

  const onStop = useCallback(() => {
    odl.stop();
    setConnected(false);
  }, []);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 1200);
  }, []);

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="dark-content" />
      <ScrollView
        ref={scrollRef}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }>
        {/* ── SDK 连接配置 ─────────────────────────────── */}
        <Text style={styles.h1}>OmniDebugLink Sample</Text>
        <TextInput
          style={styles.tokenInput}
          placeholder="粘贴设备 clientToken 后点连接"
          value={token}
          onChangeText={setToken}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <View style={styles.row}>
          <View style={styles.grow}>
            <Button
              title={connected ? '断开' : '连接'}
              onPress={connected ? onStop : onStart}
              color={connected ? '#c62828' : '#1565c0'}
            />
          </View>
        </View>
        <View style={styles.row}>
          <Text>写操作开关 (actionsEnabled)</Text>
          <Switch
            value={actionsEnabled}
            onValueChange={(v) => {
              setActionsEnabled(v);
              odl.setActionsEnabled(v);
            }}
          />
        </View>
        <Text style={styles.status}>
          状态：{connected ? '已连接（token 被顶替会自动停机）' : '未连接'}
        </Text>

        {/* ── 文本 ─────────────────────────────────────── */}
        <Text style={styles.h2}>文本 Text</Text>
        <Text style={styles.bold}>加粗文本</Text>
        <Text style={styles.colorText}>彩色文本</Text>
        <Text numberOfLines={1}>
          这是一段很长的文本会被截断显示一行，测试 numberOfLines 属性的表现
        </Text>

        {/* ── 输入 ─────────────────────────────────────── */}
        <Text style={styles.h2}>输入 TextInput</Text>
        <Text>受控输入（value 由 state 驱动）：{controlledText}</Text>
        <TextInput
          style={styles.input}
          value={controlledText}
          onChangeText={setControlledText}
          placeholder="受控输入"
        />
        <TextInput
          style={styles.input}
          placeholder="非受控输入（input_text 的稳定靶子）"
          onChangeText={setUncontrolledText}
        />
        {uncontrolledText.length > 0 && (
          <Text>非受控输入镜像：{uncontrolledText}</Text>
        )}
        <TextInput
          style={styles.input}
          placeholder="密码输入（secureTextEntry）"
          secureTextEntry
        />
        <TextInput
          style={[styles.input, styles.multiline]}
          placeholder="多行输入"
          multiline
        />

        {/* ── 按钮 ─────────────────────────────────────── */}
        <Text style={styles.h2}>按钮</Text>
        <Button
          title={`Button：点击了 ${pressCount} 次`}
          onPress={() => setPressCount((c) => c + 1)}
        />
        <Pressable
          style={({pressed}) => [
            styles.pressable,
            pressed && styles.pressed,
          ]}
          onPress={() => setPressCount((c) => c + 1)}>
          <Text style={styles.pressableText}>Pressable 按钮（点我）</Text>
        </Pressable>
        <TouchableOpacity
          style={styles.touchable}
          onPress={() => setTouchOpacityCount((c) => c + 1)}>
          <Text>TouchableOpacity：{touchOpacityCount} 次</Text>
        </TouchableOpacity>
        <TouchableHighlight
          style={styles.touchable}
          underlayColor="#ddd"
          onPress={() => setHighlightCount((c) => c + 1)}>
          <Text>TouchableHighlight：{highlightCount} 次</Text>
        </TouchableHighlight>

        {/* ── 开关 ─────────────────────────────────────── */}
        <Text style={styles.h2}>开关 Switch</Text>
        <View style={styles.row}>
          <Text>开关状态：{switchValue ? '开' : '关'}</Text>
          <Switch
            value={switchValue}
            onValueChange={setSwitchValue}
            accessibilityLabel="演示开关"
          />
        </View>

        {/* ── 指示器 / 加载 ────────────────────────────── */}
        <Text style={styles.h2}>指示器 ActivityIndicator</Text>
        <View style={styles.row}>
          <Button
            title={loading ? '停止加载动画' : '启动加载动画'}
            onPress={() => setLoading((v) => !v)}
          />
          {loading && <ActivityIndicator size="large" color="#1565c0" />}
        </View>

        {/* ── 图片 ─────────────────────────────────────── */}
        <Text style={styles.h2}>图片 Image</Text>
        <Image
          source={{uri: 'https://reactnative.dev/img/tiny_logo.png'}}
          style={styles.image}
        />

        {/* ── 列表 FlatList（独立滚动容器） ─────────────── */}
        <Text style={styles.h2}>列表 FlatList</Text>
        <FlatList
          data={DATA}
          keyExtractor={(item) => item.id}
          style={styles.flatList}
          nestedScrollEnabled
          renderItem={({item, index}) => (
            <TouchableOpacity
              style={styles.listItem}
              onPress={() => setLastTapped(item.title)}>
              <Text>{item.title}</Text>
              <Text style={styles.listIndex}>#{index + 1}</Text>
            </TouchableOpacity>
          )}
        />
        {lastTapped !== null && (
          <Text style={styles.lastTapped}>最后点击的列表项：{lastTapped}</Text>
        )}

        {/* ── 模态 Modal ───────────────────────────────── */}
        <Text style={styles.h2}>模态 Modal</Text>
        <Button
          title="打开 Modal"
          onPress={() => setModalVisible(true)}
        />
        <Modal
          visible={modalVisible}
          animationType="slide"
          transparent
          onRequestClose={() => setModalVisible(false)}>
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard}>
              <Text style={styles.h2}>模态对话框</Text>
              <Text>ui_click / send_key(back) 可以把我关掉</Text>
              <Button
                title="关闭"
                onPress={() => setModalVisible(false)}
              />
            </View>
          </View>
        </Modal>

        <Text style={styles.footer}>
          屏幕尺寸：
          {Dimensions.get('window').width.toFixed(0)}×
          {Dimensions.get('window').height.toFixed(0)}
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#fff'},
  h1: {fontSize: 22, fontWeight: '700', margin: 16},
  h2: {
    fontSize: 16,
    fontWeight: '600',
    marginTop: 24,
    marginBottom: 8,
    marginHorizontal: 16,
    color: '#37474f',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#b0bec5',
    paddingBottom: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: 16,
    marginVertical: 6,
    gap: 12,
  },
  grow: {flex: 1},
  tokenInput: {
    borderWidth: 1,
    borderColor: '#90a4ae',
    borderRadius: 6,
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  status: {marginHorizontal: 16, color: '#546e7a', fontSize: 12},
  bold: {fontWeight: '700', marginHorizontal: 16, marginVertical: 4},
  colorText: {color: '#1565c0', marginHorizontal: 16, marginVertical: 4},
  input: {
    borderWidth: 1,
    borderColor: '#cfd8dc',
    borderRadius: 6,
    marginHorizontal: 16,
    marginVertical: 6,
    paddingHorizontal: 10,
  },
  multiline: {height: 72, textAlignVertical: 'top'},
  pressable: {
    backgroundColor: '#1565c0',
    borderRadius: 6,
    padding: 12,
    marginHorizontal: 16,
    marginVertical: 6,
    alignItems: 'center',
  },
  pressed: {backgroundColor: '#0d47a1'},
  pressableText: {color: '#fff', fontWeight: '600'},
  touchable: {
    borderWidth: 1,
    borderColor: '#90a4ae',
    borderRadius: 6,
    padding: 12,
    marginHorizontal: 16,
    marginVertical: 6,
    alignItems: 'center',
  },
  image: {width: 60, height: 60, marginHorizontal: 16, marginVertical: 8},
  flatList: {
    height: 220,
    borderWidth: 1,
    borderColor: '#eceff1',
    marginHorizontal: 16,
  },
  listItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eceff1',
  },
  listIndex: {color: '#90a4ae'},
  lastTapped: {color: '#1565c0', marginHorizontal: 16, marginTop: 8, fontWeight: '600'},
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 20,
    gap: 12,
  },
  footer: {
    textAlign: 'center',
    color: '#90a4ae',
    marginVertical: 24,
    fontSize: 12,
  },
});
