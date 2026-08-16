import React, {useState, useEffect, useCallback} from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ScrollView,
  ActivityIndicator,
  PermissionsAndroid,
  Platform,
  Linking,
  BackHandler,
} from 'react-native';
import RNBluetoothClassic, {
  BluetoothDevice,
} from 'react-native-bluetooth-classic';
import iconv from 'iconv-lite';
const qrcode = require('qrcode-generator');
import {Buffer} from 'buffer';
global.Buffer = Buffer;

interface LabelItem {
  customer: string; // v5.4.5: 다중 고객사 혼적 지원
  barcode: string;
  name: string;
  qty: string;
}

interface LabelData {
  pltno: string;
  barcode: string;
  name: string;
  customer: string;            // 첫 번째 고객사 (단일 표시 fallback)
  qty: string;
  items: LabelItem[];          // 동일 PLT.NO의 모든 SKU
  isMixed: boolean;
  customers: string[];         // v5.4.5: 모든 고유 고객사
  hasMultipleCustomers: boolean; // v5.4.5: 다중 고객사 여부
  fmt: string;                 // v5.5: 라벨 포맷 ('' = 기본 1줄, '2line' = SKU명+바코드 2줄)
  qr: string;                  // v5.6: QR에 인코딩할 내용(URL 등). 없으면 pltno 사용 (입고PDA 하위호환)
}

export default function App() {
  const [devices, setDevices] = useState<BluetoothDevice[]>([]);
  const [connectedDevice, setConnectedDevice] = useState<BluetoothDevice | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isPrinting, setIsPrinting] = useState(false);
  const [status, setStatus] = useState('프린터를 연결해주세요');
  const [labelData, setLabelData] = useState<LabelData | null>(null);

  // 딥링크 파싱 (v5.4.5: 다중 고객사 혼적 지원)
  const parseLabelUrl = useCallback((url: string) => {
    try {
      const paramStr = url.split('?')[1];
      if (!paramStr) return;
      const params = new URLSearchParams(paramStr);

      const primaryCustomer = decodeURIComponent(params.get('customer') || '');

      // items JSON 파싱 (혼적 + 다중 고객사 지원)
      // 형식: [{c:고객사, b:바코드, n:품명, q:수량}, ...]
      let items: LabelItem[] = [];
      const itemsRaw = params.get('items');
      if (itemsRaw) {
        try {
          const decoded = decodeURIComponent(itemsRaw);
          const parsed = JSON.parse(decoded);
          if (Array.isArray(parsed)) {
            items = parsed.map((it: any) => ({
              customer: String(it.c || it.customer || primaryCustomer || ''),
              barcode: String(it.b || it.barcode || ''),
              name: String(it.n || it.name || ''),
              qty: String(it.q || it.qty || ''),
            }));
          }
        } catch (e) {
          console.warn('items JSON 파싱 실패:', e);
        }
      }

      const singleBarcode = decodeURIComponent(params.get('barcode') || '');
      const singleName = decodeURIComponent(params.get('name') || '');
      const singleQty = decodeURIComponent(params.get('qty') || '');

      // 하위호환: items가 없으면 단일 항목으로 구성
      if (items.length === 0 && singleBarcode) {
        items = [{
          customer: primaryCustomer,
          barcode: singleBarcode,
          name: singleName,
          qty: singleQty,
        }];
      }

      const mixedFlag = params.get('mixed') === '1' || items.length > 1;

      // v5.4.5: customers 파라미터 (| 구분) 파싱
      const customersRaw = decodeURIComponent(params.get('customers') || '');
      let customers: string[] = customersRaw
        ? customersRaw.split('|').map(s => s.trim()).filter(s => s.length > 0)
        : [];

      // customers 파라미터가 비어있으면 items에서 추출
      if (customers.length === 0) {
        const customerSet: {[key: string]: boolean} = {};
        items.forEach(it => {
          if (it.customer && !customerSet[it.customer]) {
            customerSet[it.customer] = true;
            customers.push(it.customer);
          }
        });
        if (customers.length === 0 && primaryCustomer) customers = [primaryCustomer];
      }

      const hasMultipleCustomers =
        params.get('multiCustomer') === '1' || customers.length > 1;

      const data: LabelData = {
        pltno: decodeURIComponent(params.get('pltno') || ''),
        barcode: singleBarcode,
        name: singleName,
        customer: primaryCustomer,
        qty: singleQty,
        items: items,
        isMixed: mixedFlag,
        customers: customers,
        hasMultipleCustomers: hasMultipleCustomers,
        fmt: (params.get('fmt') || '').toLowerCase(),
        qr: decodeURIComponent(params.get('qr') || ''),
      };

      if (data.pltno) {
        setLabelData(data);
        let statusMsg: string;
        if (hasMultipleCustomers) {
          statusMsg = '다중 고객사 혼적 라벨 (' + customers.length + '사 · ' + items.length + '건) - 프린터 선택';
        } else if (mixedFlag) {
          statusMsg = '혼적 라벨 데이터 수신 (' + items.length + '건) - 프린터를 선택하세요';
        } else {
          statusMsg = '라벨 데이터 수신 - 프린터를 선택하세요';
        }
        setStatus(statusMsg);
        loadPairedDevices();
      }
    } catch (e) {
      console.warn('딥링크 파싱 오류:', e);
    }
  }, []);

  useEffect(() => {
    requestPermissions();

    // 앱이 딥링크로 열린 경우
    Linking.getInitialURL().then(url => {
      if (url) parseLabelUrl(url);
    });

    // 앱이 이미 실행 중일 때 딥링크 수신
    const sub = Linking.addEventListener('url', ({url}) => {
      parseLabelUrl(url);
    });

    return () => sub.remove();
  }, [parseLabelUrl]);

  async function requestPermissions() {
    if (Platform.OS === 'android') {
      try {
        await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]);
      } catch (err) {
        console.warn(err);
      }
    }
  }

  async function loadPairedDevices() {
    try {
      setIsScanning(true);
      const paired = await RNBluetoothClassic.getBondedDevices();
      // Sewoo 프린터로 보이는 기기만 노출 (다른 BT기기 잘못 선택해서 SPP 연결 실패하는 사고 방지)
      const printerPattern = /^(SW[_-]|Sewoo|LK-)/i;
      const printers = paired.filter(d => d.name && printerPattern.test(d.name));
      setDevices(printers);
      if (printers.length === 0) {
        setStatus(
          paired.length === 0
            ? '페어링된 기기가 없습니다'
            : '페어링된 Sewoo 프린터가 없습니다 - 블루투스 설정에서 프린터를 페어링해주세요',
        );
      } else if (printers.length === 1) {
        setStatus('프린터: ' + (printers[0].name || '') + ' - 탭하여 출력');
      } else {
        setStatus(printers.length + '대 프린터 발견 - 선택하세요');
      }
    } catch (err: any) {
      setStatus('오류: ' + err.message);
    } finally {
      setIsScanning(false);
    }
  }

  async function selectAndPrint(device: BluetoothDevice) {
    if (!labelData) {
      Alert.alert('오류', '출력할 라벨 데이터가 없습니다');
      return;
    }

    try {
      setStatus(device.name + ' 연결 중...');
      setIsPrinting(true);

      // 연결
      let targetDevice = connectedDevice;
      if (!targetDevice || targetDevice.address !== device.address) {
        if (connectedDevice) {
          try { await connectedDevice.disconnect(); } catch {}
        }
        await device.connect({
          SERVICE_UUID: '00001101-0000-1000-8000-00805F9B34FB',
        });
        targetDevice = device;
        setConnectedDevice(device);
      }

      setStatus('출력 중...');

      // CPCL 라벨 출력
      await printCPCL(targetDevice, labelData);

      setStatus('출력 완료!');
      Alert.alert('출력 완료', labelData.pltno + ' 라벨이 출력되었습니다', [
        {text: '확인', onPress: () => {
          // 웹앱으로 돌아가기
          BackHandler.exitApp();
        }},
      ]);
    } catch (err: any) {
      setStatus('출력 실패: ' + err.message);
      Alert.alert('출력 실패', err.message);
    } finally {
      setIsPrinting(false);
    }
  }

  // QR 코드를 1비트 비트맵으로 생성하여 CPCL EG 명령용 HEX 데이터 반환
  function generateQrGraphic(text: string, moduleSize: number = 4): {hex: string; widthBytes: number; height: number} {
    const qr = qrcode(0, 'M');
    // QR 코드에서 ㅡ → ~ 로 치환 (QR은 ASCII만 안정적)
    const qrText = text.replace(/ㅡ/g, '~');
    qr.addData(qrText);
    qr.make();

    const moduleCount = qr.getModuleCount();
    // QR 표준 여백(quiet zone): 사방 4모듈의 흰 테두리. 휴대폰 카메라 QR 리더는
    // 이 여백이 있어야 finder 패턴 위치를 잡음. (PDA 산업용 스캐너는 여백 없어도 읽힘)
    const quiet = 4;
    const totalModules = moduleCount + quiet * 2;
    const imgSize = totalModules * moduleSize;
    const widthBytes = Math.ceil(imgSize / 8);

    let hex = '';
    for (let y = 0; y < imgSize; y++) {
      const moduleY = Math.floor(y / moduleSize) - quiet;
      for (let byteIdx = 0; byteIdx < widthBytes; byteIdx++) {
        let byte = 0;
        for (let bit = 0; bit < 8; bit++) {
          const px = byteIdx * 8 + bit;
          const moduleX = Math.floor(px / moduleSize) - quiet;
          if (
            moduleX >= 0 && moduleY >= 0 &&
            moduleX < moduleCount && moduleY < moduleCount &&
            qr.isDark(moduleY, moduleX)
          ) {
            byte |= (0x80 >> bit);
          }
        }
        hex += byte.toString(16).padStart(2, '0').toUpperCase();
      }
    }

    return {hex, widthBytes, height: imgSize};
  }

  async function printCPCL(device: BluetoothDevice, data: LabelData) {
    const sendRaw = async (buf: Buffer) => {
      const CHUNK = 512;
      for (let i = 0; i < buf.length; i += CHUNK) {
        const chunk = buf.slice(i, i + CHUNK);
        await device.write(chunk.toString('base64'), 'base64');
        await new Promise(r => setTimeout(r, 50));
      }
    };

    // 출력할 항목 (items가 비어있으면 단일 항목으로 fallback)
    const items: LabelItem[] = data.items && data.items.length > 0
      ? data.items
      : [{
          customer: data.customer,
          barcode: data.barcode,
          name: data.name,
          qty: data.qty,
        }];
    const isMixed = items.length > 1;
    const hasMultiCust = data.hasMultipleCustomers === true;

    // 고객사별로 그룹화 (입력 순서 유지)
    const groupOrder: string[] = [];
    const groups: {[customer: string]: LabelItem[]} = {};
    items.forEach(it => {
      const c = it.customer || '(미지정)';
      if (!groups[c]) {
        groups[c] = [];
        groupOrder.push(c);
      }
      groups[c].push(it);
    });

    // QR 코드 (UTF-8 한글 ㅡ 완벽 지원)
    // 출고용(fmt=2line): 2026-08-16 현장 요청으로 4 → 6 (1.5배).
    //   항목 리스트를 QR 조회로 옮기면서 공간이 남았고, 송장 매칭 때 박스 QR 을 자주 찍게 돼
    //   작은 QR 이 불편했다. labelHeight 가 qrImg.height 를 더해 자동으로 늘어나고
    //   qrX 가 가운데 정렬을 다시 잡으므로 나머지 배치는 손댈 곳이 없다.
    //   폭 여유: 60자 URL 기준 약 45모듈 × 6 = 270px < 라벨 576px.
    const qrModuleSize = data.fmt === '2line' ? 6 : 10;
    // v5.6: 출고(fmt=2line) + qr 파라미터가 있을 때만 QR을 URL로. 입고는 항상 pltno (영향 금지)
    const qrContent = (data.fmt === '2line' && data.qr) ? data.qr : data.pltno;
    const qrImg = generateQrGraphic(qrContent, qrModuleSize);
    const labelWidth = 576;
    const qrPixelWidth = qrImg.widthBytes * 8;
    const qrX = Math.max(0, Math.floor((labelWidth - qrPixelWidth) / 2));

    // 라벨 높이 계산 (하단 항목은 평면 리스트, 고객사 그룹 헤더 없음)
    const is2Line = data.fmt === '2line';
    const headerHeight = 160;
    const pltnoBlockHeight = 40; // PLT.NO와 첫 항목 간격
    const itemLineHeight = 40; // 입고(1줄 항목) 높이
    const bottomPadding = 30;

    // 출고용(2line): 큰 출고번호 + 더 큰 박스/파렛번호 블록 높이 (항목 리스트 없음)
    // 2026-05-30: 출고번호 SETMAG 2 2(×2), 박스번호 SETMAG 4 4(×4)로 더 크게
    // 박스번호는 출고번호 바로 밑에 배치 + 잘리지 않게 하단 여유 넉넉히
    const shipNoBlockHeight = 120;  // 출고번호(폰트0 size2 ×2)
    const boxNoBlockHeight = 480;   // 박스/파렛번호(폰트0 size5 ×4) — 하단 클립 방지 여유 포함

    let labelHeight;
    if (is2Line) {
      labelHeight =
        headerHeight + qrImg.height + 20 +
        shipNoBlockHeight + boxNoBlockHeight + bottomPadding;
    } else {
      const totalItemLines = items.length * itemLineHeight;
      labelHeight =
        headerHeight + qrImg.height + 20 + pltnoBlockHeight +
        totalItemLines + bottomPadding;
    }

    const cpclLines: string[] = [];
    cpclLines.push('! 0 200 200 ' + labelHeight + ' 1');

    // ===== 상단: 고객사 표기 =====
    cpclLines.push('CENTER');
    if (hasMultiCust) {
      // 다중 고객사: "N개 고객사 혼적" + 아래 줄에 고객사명 나열
      cpclLines.push('TEXT 55 1 0 10 ' + groupOrder.length + '개 고객사 혼적');
      const custLine = groupOrder.join(' / ');
      // 너무 길면 잘라냄 (한 줄 라벨 가독성)
      const trimmedCust = custLine.length > 32 ? custLine.substring(0, 32) + '…' : custLine;
      cpclLines.push('TEXT 55 0 0 60 ' + trimmedCust);
      cpclLines.push('TEXT 55 0 0 100 ※ 혼적 ' + items.length + '건 · 다중 고객사');
    } else {
      // 단일 고객사
      cpclLines.push('TEXT 55 2 0 10 ' + (data.customer || groupOrder[0] || ''));
      if (isMixed) {
        cpclLines.push('TEXT 55 0 0 90 ※ 혼적 ' + items.length + '건');
      } else {
        cpclLines.push('TEXT 55 0 0 90 ' + items[0].name);
      }
    }
    cpclLines.push('LEFT');
    cpclLines.push('LINE 10 140 566 140 1');

    // ===== QR 코드 =====
    cpclLines.push(
      'EG ' + qrImg.widthBytes + ' ' + qrImg.height + ' ' + qrX + ' 160 ' + qrImg.hex,
    );

    // ===== 출고번호 + 박스/파렛 번호 =====
    const pltnoY = headerHeight + qrImg.height + 10;
    cpclLines.push('LINE 10 ' + pltnoY + ' 566 ' + pltnoY + ' 1');
    cpclLines.push('CENTER');

    if (is2Line) {
      // 출고용: 출고번호(크게) + 박스/파렛번호(더 크게). 항목 리스트는 QR로 조회하므로 미출력.
      // pltno = "출고번호-B1" → 마지막 '-' 기준으로 출고번호 / 박스(파렛)번호 분리
      const lastDash = data.pltno.lastIndexOf('-');
      const shipPart = lastDash > 0 ? data.pltno.substring(0, lastDash) : data.pltno;
      const boxPart = lastDash > 0 ? data.pltno.substring(lastDash + 1) : '';

      cpclLines.push('SETBOLD 1');
      // 출고번호 (폰트0 size2 ×2)
      cpclLines.push('SETMAG 2 2');
      cpclLines.push('TEXT 0 2 0 ' + (pltnoY + 25) + ' ' + shipPart);
      // 박스/파렛 번호 (폰트0 size5 ×4 — 출고번호 ×2의 2배) — 출고번호 바로 밑에 배치
      if (boxPart) {
        cpclLines.push('SETMAG 4 4');
        cpclLines.push('TEXT 0 5 0 ' + (pltnoY + 100) + ' ' + boxPart);
      }
      cpclLines.push('SETMAG 1 1'); // 배율 원복 (이후 텍스트 영향 방지)
      cpclLines.push('SETBOLD 0');
      cpclLines.push('LEFT');
    } else {
      // 입고용(기존): pltno 한 줄 + 항목 목록(바코드+수량 1줄)
      cpclLines.push('TEXT 55 3 0 ' + (pltnoY + 10) + ' ' + data.pltno);
      cpclLines.push('LEFT');
      let curY = pltnoY + pltnoBlockHeight;
      items.forEach((item, idx) => {
        const prefix = isMixed ? (idx + 1) + '. ' : '';
        const line = prefix + item.barcode + '   ' + item.qty + 'EA';
        cpclLines.push('TEXT 55 0 30 ' + curY + ' ' + line);
        curY += itemLineHeight;
      });
    }

    cpclLines.push('FORM');
    cpclLines.push('PRINT');

    const cpclText = cpclLines.join('\r\n') + '\r\n';
    const encoded = iconv.encode(cpclText, 'EUC-KR');
    await sendRaw(Buffer.from(encoded));
  }

  // 딥링크로 열렸을 때 (라벨 데이터 있음)
  if (labelData) {
    // 출고(2line) 미리보기용: pltno "출고번호-B1" → 출고번호 / 박스(파렛)번호 분리
    const pvDash = labelData.pltno ? labelData.pltno.lastIndexOf('-') : -1;
    const pvShip = pvDash > 0 ? labelData.pltno.substring(0, pvDash) : labelData.pltno;
    const pvBox = pvDash > 0 ? labelData.pltno.substring(pvDash + 1) : '';
    return (
      <ScrollView style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>라벨 출력</Text>
          <Text style={styles.headerSub}>Sewoo LK-P30IIB</Text>
        </View>

        <View style={[styles.statusBox, isPrinting ? styles.statusPrinting : styles.statusDisconnected]}>
          <Text style={styles.statusText}>{status}</Text>
        </View>

        {/* 라벨 미리보기 (v5.4.5: 다중 고객사 그룹화 지원) */}
        <View style={styles.labelPreview}>
          <Text style={styles.listTitle}>
            라벨 미리보기
            {labelData.hasMultipleCustomers
              ? ' (' + labelData.customers.length + '사 혼적 · ' + labelData.items.length + '건)'
              : labelData.isMixed
                ? ' (혼적 ' + labelData.items.length + '건)'
                : ''}
          </Text>
          <View style={styles.labelBox}>
            {labelData.hasMultipleCustomers ? (
              <>
                <Text style={[styles.labelCustomer, {fontSize: 17, color: '#d84315'}]}>
                  🏢 {labelData.customers.length}개 고객사 혼적
                </Text>
                <Text style={[styles.labelName, {color: '#e91e63', fontWeight: 'bold'}]}>
                  ※ 혼적 {labelData.items.length}건 · 다중 고객사
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.labelCustomer}>{labelData.customer}</Text>
                {labelData.isMixed ? (
                  <Text style={[styles.labelName, {color: '#e91e63', fontWeight: 'bold'}]}>
                    ※ 혼적 {labelData.items.length}건
                  </Text>
                ) : (
                  <Text style={styles.labelName}>
                    {labelData.items[0]?.name || labelData.name}
                  </Text>
                )}
              </>
            )}
            <Text style={styles.labelDivider}>{'─'.repeat(20)}</Text>
            <View style={styles.qrPlaceholder}>
              <Text style={styles.qrText}>QR: {(labelData.fmt === '2line' && labelData.qr) ? labelData.qr : labelData.pltno}</Text>
            </View>
            <Text style={styles.labelDivider}>{'─'.repeat(20)}</Text>
            {labelData.fmt === '2line' ? (
              // 출고용: 출고번호(크게) + 박스/파렛번호(더 크게), 항목 리스트 없음(QR로 조회)
              <>
                <Text style={styles.labelShipNo}>{pvShip}</Text>
                {pvBox ? <Text style={styles.labelBoxNo}>{pvBox}</Text> : null}
              </>
            ) : (
              // 입고용(기존): pltno + 바코드+수량 1줄 리스트
              <>
                <Text style={styles.labelPltno}>{labelData.pltno}</Text>
                <View style={styles.itemsList}>
                  {labelData.items.map((item, idx) => (
                    <View key={idx} style={styles.itemRow}>
                      <Text style={styles.itemBarcode}>
                        {labelData.isMixed ? idx + 1 + '. ' : ''}
                        {item.barcode}
                      </Text>
                      <Text style={styles.itemQty}>{item.qty}EA</Text>
                    </View>
                  ))}
                </View>
              </>
            )}
          </View>
        </View>

        {/* 프린터 선택 */}
        <View style={styles.deviceList}>
          <Text style={styles.listTitle}>프린터 선택</Text>
          {isScanning ? (
            <ActivityIndicator size="large" color="#007bff" style={{padding: 20}} />
          ) : devices.length > 0 ? (
            devices.map(device => (
              <TouchableOpacity
                key={device.address}
                style={styles.deviceItem}
                onPress={() => selectAndPrint(device)}
                disabled={isPrinting}>
                <Text style={styles.deviceName}>{device.name || '이름 없음'}</Text>
                <Text style={styles.deviceAddress}>{device.address}</Text>
              </TouchableOpacity>
            ))
          ) : (
            <Text style={styles.noDeviceText}>페어링된 기기가 없습니다</Text>
          )}
          <TouchableOpacity
            style={styles.btnRefresh}
            onPress={loadPairedDevices}
            disabled={isScanning || isPrinting}>
            <Text style={styles.btnText}>기기 목록 새로고침</Text>
          </TouchableOpacity>
        </View>

        {isPrinting && (
          <View style={styles.printingOverlay}>
            <ActivityIndicator size="large" color="#ff6b35" />
            <Text style={styles.printingText}>출력 중...</Text>
          </View>
        )}
      </ScrollView>
    );
  }

  // 일반 모드 (딥링크 없이 직접 실행)
  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>라벨 출력</Text>
        <Text style={styles.headerSub}>Sewoo LK-P30IIB</Text>
      </View>

      <View style={styles.infoBox}>
        <Text style={styles.infoTitle}>웹앱 연동 모드</Text>
        <Text style={styles.infoText}>
          이 앱은 PDA 웹앱의 "라벨 출력" 버튼을 통해 자동으로 실행됩니다.{'\n\n'}
          웹앱에서 바코드/PLT.NO 검색 후 라벨 출력 버튼을 눌러주세요.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#f0f2f5'},
  header: {backgroundColor: '#ff6b35', padding: 30, alignItems: 'center'},
  headerTitle: {color: 'white', fontSize: 28, fontWeight: 'bold'},
  headerSub: {color: 'white', fontSize: 16, opacity: 0.9, marginTop: 5},
  statusBox: {margin: 15, padding: 15, borderRadius: 10, alignItems: 'center'},
  statusPrinting: {backgroundColor: '#fff3cd', borderWidth: 2, borderColor: '#ffc107'},
  statusDisconnected: {backgroundColor: '#f8f9fa', borderWidth: 2, borderColor: '#dee2e6'},
  statusText: {fontSize: 16, fontWeight: 'bold', color: '#333'},
  labelPreview: {margin: 15, backgroundColor: 'white', borderRadius: 10, padding: 15},
  labelBox: {borderWidth: 2, borderColor: '#333', borderRadius: 8, padding: 15, alignItems: 'center', marginBottom: 10},
  labelCustomer: {fontSize: 20, fontWeight: 'bold', color: '#333'},
  labelName: {fontSize: 14, color: '#666', marginTop: 3},
  labelDivider: {fontSize: 12, color: '#999', marginVertical: 8},
  qrPlaceholder: {width: 120, height: 120, backgroundColor: '#f0f0f0', borderWidth: 1, borderColor: '#ccc', alignItems: 'center', justifyContent: 'center', marginVertical: 5},
  qrText: {fontSize: 11, color: '#666', textAlign: 'center'},
  labelPltno: {fontSize: 26, fontWeight: 'bold', color: '#1a1a1a'},
  labelPltnoSmall: {fontSize: 24, fontWeight: 'bold'},
  labelShipNo: {fontSize: 44, fontWeight: 'bold', color: '#1a1a1a', textAlign: 'center'},
  labelBoxNo: {fontSize: 150, fontWeight: 'bold', color: '#059669', textAlign: 'center', marginTop: 2, letterSpacing: 1},
  labelBarcode: {fontSize: 13, color: '#666', marginTop: 5},
  labelQty: {fontSize: 13, color: '#666', marginTop: 3},
  itemsList: {marginTop: 8, width: '100%'},
  itemRow: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: '#eee'},
  itemBarcode: {fontSize: 13, color: '#333', fontFamily: 'monospace', flex: 1},
  itemQty: {fontSize: 13, color: '#e91e63', fontWeight: 'bold', marginLeft: 10},
  item2LineBlock: {paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#eee'},
  itemName: {fontSize: 14, color: '#222', fontWeight: '600'},
  itemRowSub: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 2, paddingLeft: 12},
  itemBarcodeSub: {fontSize: 12, color: '#666', fontFamily: 'monospace', flex: 1},
  groupHeader: {paddingVertical: 5, marginTop: 6, borderBottomWidth: 1.5, borderBottomColor: '#d84315', alignItems: 'center'},
  groupHeaderText: {fontSize: 12, fontWeight: '900', color: '#d84315'},
  deviceList: {margin: 15, backgroundColor: 'white', borderRadius: 10, padding: 15},
  listTitle: {fontSize: 18, fontWeight: 'bold', color: '#495057', marginBottom: 10},
  deviceItem: {padding: 18, borderWidth: 2, borderColor: '#dee2e6', borderRadius: 8, marginBottom: 8, backgroundColor: '#f8f9fa'},
  deviceName: {fontSize: 18, fontWeight: 'bold', color: '#333'},
  deviceAddress: {fontSize: 13, color: '#888', marginTop: 3},
  noDeviceText: {fontSize: 15, color: '#999', textAlign: 'center', padding: 20},
  btnRefresh: {backgroundColor: '#007bff', padding: 15, borderRadius: 10, alignItems: 'center', marginTop: 10},
  btnText: {color: 'white', fontSize: 16, fontWeight: 'bold'},
  printingOverlay: {alignItems: 'center', padding: 30},
  printingText: {fontSize: 18, fontWeight: 'bold', color: '#ff6b35', marginTop: 10},
  infoBox: {margin: 15, backgroundColor: 'white', borderRadius: 10, padding: 25, alignItems: 'center'},
  infoTitle: {fontSize: 20, fontWeight: 'bold', color: '#495057', marginBottom: 15},
  infoText: {fontSize: 15, color: '#666', textAlign: 'center', lineHeight: 24},
});
