// SANKET VAANNI — RIGHT GLOVE OLED VIDEO + BLE FIRMWARE V12 FINAL
// Factory default OLED layout is preserved; the app may use a separate custom layout and Restore Default.
// Pins retained from the current working setup: SDA=20, SCL=21, MUX=4..7, battery S=GPIO1.
// Startup plays converted monochrome frames from SanketVaanni_StartupVideo.h.
// Battery divider ratio below is an initial estimate based on the observed ~0.996V ADC signal.

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Adafruit_ADS1X15.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <math.h>
#include <Preferences.h>
#include <cstring>
#include "SanketVaanni_StartupVideo.h"
#include "SanketModel.h"

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
#define OLED_ADDR 0x3C
#define SDA_PIN 20
#define SCL_PIN 21
#define MPU_ADDR 0x68
#define ADS_ADDR 0x48
#define MUX_S0 4
#define MUX_S1 5
#define MUX_S2 6
#define MUX_S3 7
#define BATTERY_PIN 1

// CHANGE after measuring the voltage sensor board with a multimeter.
// Example: if GPIO1 measures 1.50 V while battery is 4.00 V, ratio = 4.00/1.50.
const float BATTERY_DIVIDER_RATIO = 3.7f; // provisional estimate from observed ADC; calibrate with a meter
const float BATTERY_EMPTY_V = 3.30f;
const float BATTERY_FULL_V  = 4.20f;

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
Adafruit_ADS1115 ads;
bool oled_ok=false, ads_ok=false, mpu_ok=false;
int flexRaw[5]={0,0,0,0,0};

struct MPUData {
  int16_t AccX,AccY,AccZ,GyroX,GyroY,GyroZ;
  float TempC;
};
MPUData mpu={};
float pitch=0, roll=0, oldPitch=0, oldRoll=0;
float batteryVoltage=0, batteryPinVoltage=0;
int batteryPercent=-1;
bool batteryPlausible=false;
bool bleConnected=false;
unsigned long sensorTimer=0, displayTimer=0, batteryTimer=0, bleTimer=0, predictionTimer=0, pageTimer=0;

// Rolling 50-frame window buffer (5.0s at 10Hz) and embedded inference state
#define SANKET_ROLLING_WINDOW_FRAMES 50
float rollingWindow[SANKET_ROLLING_WINDOW_FRAMES][SANKET_CHANNEL_COUNT];
int windowFrameCount = 0;
SanketPrediction currentPrediction = {"UNKNOWN", 0.0f, 0.0f, false, true};
char stablePredictionLabel[32] = "UNKNOWN";
int stableConsecutiveCount = 0;

// Factory defaults are compiled into firmware and never overwritten by a custom layout.
static const int DEFAULT_TITLE_X=0, DEFAULT_TITLE_Y=0;
static const int DEFAULT_BATTERY_X=102, DEFAULT_BATTERY_Y=3;
static const int DEFAULT_TEMP_X=98, DEFAULT_TEMP_Y=55;

int titleX=DEFAULT_TITLE_X, titleY=DEFAULT_TITLE_Y;
int batteryX=DEFAULT_BATTERY_X, batteryY=DEFAULT_BATTERY_Y;
int tempX=DEFAULT_TEMP_X, tempY=DEFAULT_TEMP_Y;
bool customLayoutEnabled=false;
Preferences layoutPrefs;

// Custom 1-bit Devanagari bitmap: "संकेत वाणी", rendered for this 128x64 OLED.
const uint8_t hindiTitleBitmap[] PROGMEM = {
  0x01, 0x04, 0x00, 0x00, 0x00, 0x11, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x09, 0x00, 0x7F, 0xFF, 0xFF, 0x8F, 0xFF, 0xFF, 0x80, 0x19, 0x04, 0x01, 0x00, 0x52, 0x59, 0x00, 0x09, 0x3C, 0x01, 0x07, 0x52, 0x59, 0x00, 0x71, 0x27, 0x9F, 0x04, 0x52, 0x59, 0x00, 0x2F, 0x26, 0x91, 0x04, 0x52, 0x59, 0x00, 0x31, 0x24, 0x91, 0x04, 0xD1, 0x99, 0x00, 0x11, 0x3C, 0x91, 0x07, 0x50, 0x19, 0x00, 0x0D, 0x04, 0x89, 0x00, 0x50, 0x19, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
};

// NEW BLE protocol V1; match these UUIDs in the Android app.
static const char* BLE_NAME="SanketVaanni-Right";
static const char* SERVICE_UUID   ="8f2a1000-7d2b-4c9a-9c4e-6b1e2f000001";
static const char* DATA_UUID      ="8f2a1001-7d2b-4c9a-9c4e-6b1e2f000001";
static const char* CONTROL_UUID   ="8f2a1002-7d2b-4c9a-9c4e-6b1e2f000001";
static const char* PREDICTION_UUID="8f2a1003-7d2b-4c9a-9c4e-6b1e2f000001";
BLECharacteristic* dataChar=nullptr;
BLECharacteristic* controlChar=nullptr;
BLECharacteristic* predChar=nullptr;

class ServerCallbacks: public BLEServerCallbacks {
  void onConnect(BLEServer*) override { bleConnected=true; Serial.println("BLE_CLIENT_CONNECTED"); }
  void onDisconnect(BLEServer* s) override {
    bleConnected=false; Serial.println("BLE_CLIENT_DISCONNECTED"); s->startAdvertising();
  }
};

int clampCoordinate(int value, int maxValue) {
  if (value < 0) return 0;
  if (value > maxValue) return maxValue;
  return value;
}

void applyDefaultLayout(bool persist) {
  titleX=DEFAULT_TITLE_X; titleY=DEFAULT_TITLE_Y;
  batteryX=DEFAULT_BATTERY_X; batteryY=DEFAULT_BATTERY_Y;
  tempX=DEFAULT_TEMP_X; tempY=DEFAULT_TEMP_Y;
  customLayoutEnabled=false;
  if (persist) {
    layoutPrefs.putBool("custom", false);
    layoutPrefs.remove("titleX"); layoutPrefs.remove("titleY");
    layoutPrefs.remove("batteryX"); layoutPrefs.remove("batteryY");
    layoutPrefs.remove("tempX"); layoutPrefs.remove("tempY");
  }
  Serial.println("OLED_LAYOUT=DEFAULT_RESTORED");
}

void loadDisplayLayout() {
  customLayoutEnabled=layoutPrefs.getBool("custom", false);
  if (!customLayoutEnabled) {
    applyDefaultLayout(false);
    return;
  }
  titleX=clampCoordinate(layoutPrefs.getInt("titleX", DEFAULT_TITLE_X), 72);
  titleY=clampCoordinate(layoutPrefs.getInt("titleY", DEFAULT_TITLE_Y), 48);
  batteryX=clampCoordinate(layoutPrefs.getInt("batteryX", DEFAULT_BATTERY_X), 94);
  batteryY=clampCoordinate(layoutPrefs.getInt("batteryY", DEFAULT_BATTERY_Y), 56);
  tempX=clampCoordinate(layoutPrefs.getInt("tempX", DEFAULT_TEMP_X), 98);
  tempY=clampCoordinate(layoutPrefs.getInt("tempY", DEFAULT_TEMP_Y), 56);
}

int jsonIntValue(const char* json, const char* key, int fallback) {
  char pattern[32];
  snprintf(pattern, sizeof(pattern), "\"%s\"", key);
  const char* keyPos=strstr(json, pattern);
  if (!keyPos) return fallback;
  const char* colon=strchr(keyPos, ':');
  if (!colon) return fallback;
  return atoi(colon+1);
}

void processDisplayCommand(const char* payload) {
  if (payload == nullptr || payload[0] == '\0') return;
  if (strstr(payload, "restore_default") || strstr(payload, "RESTORE_DEFAULT")) {
    applyDefaultLayout(true);
    return;
  }
  if (strstr(payload, "set_layout") || strstr(payload, "SET_LAYOUT")) {
    titleX=clampCoordinate(jsonIntValue(payload, "titleX", titleX), 72);
    titleY=clampCoordinate(jsonIntValue(payload, "titleY", titleY), 48);
    batteryX=clampCoordinate(jsonIntValue(payload, "batteryX", batteryX), 94);
    batteryY=clampCoordinate(jsonIntValue(payload, "batteryY", batteryY), 56);
    tempX=clampCoordinate(jsonIntValue(payload, "tempX", tempX), 98);
    tempY=clampCoordinate(jsonIntValue(payload, "tempY", tempY), 56);
    customLayoutEnabled=true;
    layoutPrefs.putBool("custom", true);
    layoutPrefs.putInt("titleX", titleX); layoutPrefs.putInt("titleY", titleY);
    layoutPrefs.putInt("batteryX", batteryX); layoutPrefs.putInt("batteryY", batteryY);
    layoutPrefs.putInt("tempX", tempX); layoutPrefs.putInt("tempY", tempY);
    Serial.println("OLED_LAYOUT=CUSTOM_SAVED");
    return;
  }
  Serial.println("OLED_CONTROL=UNKNOWN_COMMAND");
}

class DisplayControlCallbacks: public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* characteristic) override {
    String received = characteristic->getValue();
    processDisplayCommand(received.c_str());
  }
};

void startBLE() {
  BLEDevice::init(BLE_NAME);
  BLEServer* server=BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  BLEService* service=server->createService(SERVICE_UUID);
  dataChar=service->createCharacteristic(DATA_UUID,
    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  dataChar->addDescriptor(new BLE2902());
  dataChar->setValue("{\"v\":1,\"glove\":\"right\",\"status\":\"starting\"}");

  controlChar=service->createCharacteristic(
    CONTROL_UUID,
    BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR
  );
  controlChar->setCallbacks(new DisplayControlCallbacks());
  controlChar->setValue("Use JSON set_layout or restore_default");

  predChar=service->createCharacteristic(
    PREDICTION_UUID,
    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
  );
  predChar->addDescriptor(new BLE2902());
  predChar->setValue("{\"v\":1,\"glove\":\"right\",\"model_v\":\"1.0.0\",\"label\":\"UNKNOWN\",\"status\":\"warming_up\",\"score\":0.0,\"margin\":0.0}");

  service->start();
  BLEAdvertising* adv=BLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.println("BLE_ADVERTISING SanketVaanni-Right");
}

void selectMuxChannel(uint8_t ch) {
  digitalWrite(MUX_S0,(ch>>0)&1); digitalWrite(MUX_S1,(ch>>1)&1);
  digitalWrite(MUX_S2,(ch>>2)&1); digitalWrite(MUX_S3,(ch>>3)&1);
  delayMicroseconds(200);
}
bool initMPU() {
  Wire.beginTransmission(MPU_ADDR); Wire.write(0x6B); Wire.write(0x00);
  return Wire.endTransmission(true)==0;
}
MPUData readMPU() {
  MPUData d={};
  Wire.beginTransmission(MPU_ADDR); Wire.write(0x3B);
  if(Wire.endTransmission(false)!=0) return d;
  uint8_t n=Wire.requestFrom((uint8_t)MPU_ADDR,(uint8_t)14);
  if(n<14 || Wire.available()<14) return d;
  d.AccX=(int16_t)((Wire.read()<<8)|Wire.read());
  d.AccY=(int16_t)((Wire.read()<<8)|Wire.read());
  d.AccZ=(int16_t)((Wire.read()<<8)|Wire.read());
  int16_t rawTemp=(int16_t)((Wire.read()<<8)|Wire.read());
  d.TempC=(rawTemp/340.0f)+36.53f;
  d.GyroX=(int16_t)((Wire.read()<<8)|Wire.read());
  d.GyroY=(int16_t)((Wire.read()<<8)|Wire.read());
  d.GyroZ=(int16_t)((Wire.read()<<8)|Wire.read());
  return d;
}
int readFlex(uint8_t ch) {
  selectMuxChannel(ch); delay(3);
  long sum=0;
  for(int i=0;i<4;i++){ sum+=ads.readADC_SingleEnded(0); delay(2); }
  return (int)(sum/4);
}
void calculateAngles(const MPUData& d) {
  float ax=d.AccX, ay=d.AccY, az=d.AccZ;
  float p=atan2(ay,sqrt(ax*ax+az*az))*180.0f/PI;
  float r=atan2(-ax,az)*180.0f/PI;
  oldPitch=oldPitch*0.8f+p*0.2f;
  oldRoll=oldRoll*0.8f+r*0.2f;
  pitch=oldPitch; roll=oldRoll;
}
void readBattery() {
  // Average several samples, then low-pass-filter voltage to suppress ADC noise.
  static bool batteryFilterStarted = false;
  static float filteredPinVoltage = 0.0f;
  static int lastStablePercent = -1;

  uint32_t totalMilliVolts = 0;
  const int sampleCount = 24;
  for (int i = 0; i < sampleCount; ++i) {
    totalMilliVolts += analogReadMilliVolts(BATTERY_PIN);
    delayMicroseconds(250);
  }
  const float rawPinVoltage = (totalMilliVolts / (float)sampleCount) / 1000.0f;

  if (!batteryFilterStarted) {
    filteredPinVoltage = rawPinVoltage;
    batteryFilterStarted = true;
  } else {
    filteredPinVoltage = filteredPinVoltage * 0.90f + rawPinVoltage * 0.10f;
  }

  batteryPinVoltage = filteredPinVoltage;
  batteryVoltage = batteryPinVoltage * BATTERY_DIVIDER_RATIO;

  // Current estimate is based on the previously observed ~0.996V ADC reading and
  // nominal 3.7V cell. It is displayed as an estimate until measured/calibrated.
  batteryPlausible = (batteryPinVoltage > 0.05f &&
                      batteryPinVoltage < 1.30f &&
                      batteryVoltage >= 3.0f &&
                      batteryVoltage <= 4.30f);

  if (batteryPlausible) {
    const float pctFloat = (batteryVoltage - BATTERY_EMPTY_V) * 100.0f /
                           (BATTERY_FULL_V - BATTERY_EMPTY_V);
    const int candidate = constrain((int)roundf(pctFloat), 0, 100);

    // Hysteresis: change the displayed number only after a meaningful shift.
    if (lastStablePercent < 0) {
      lastStablePercent = candidate;
    } else if (abs(candidate - lastStablePercent) >= 2) {
      lastStablePercent = candidate;
    }
    batteryPercent = lastStablePercent;
  } else {
    batteryPercent = -1;
    lastStablePercent = -1;
  }
}

// Play the user-provided MP4 converted to 128x64 monochrome bitmap frames.
// Frame timing includes the OLED transfer time so playback stays near the target rate.
void runStartupAnimation() {
  if (!oled_ok) return;
  for (uint16_t f = 0; f < SV_VIDEO_FRAME_COUNT; f++) {
    unsigned long frameStart = millis();
    display.clearDisplay();
    display.drawBitmap(0, 0, svVideoFrames[f], SCREEN_WIDTH, SCREEN_HEIGHT, SSD1306_WHITE);
    display.display();
    unsigned long elapsed = millis() - frameStart;
    if (elapsed < SV_VIDEO_FRAME_DELAY_MS) delay(SV_VIDEO_FRAME_DELAY_MS - elapsed);
  }
}

// Show sensor state after the intro, then BLE state. Both are real status values.
void showSystemCheck() {
  if(!oled_ok) return;
  display.clearDisplay();
  display.setTextSize(1);
  display.setCursor(0,2); display.print("SENSORS ");
  display.setCursor(72,2); display.println((ads_ok && mpu_ok)?"OK":"CHECK");
  display.drawLine(0,13,127,13,SSD1306_WHITE);
  display.setCursor(0,20); display.print("ADS1115 : "); display.println(ads_ok?"OK":"FAIL");
  display.setCursor(0,32); display.print("MPU6050 : "); display.println(mpu_ok?"OK":"FAIL");
  display.setCursor(0,47); display.print("BLE     : "); display.println(bleConnected?"CONNECTED":"DISCONNECTED");
  display.display();
  delay(1700);
}
void showBLECheck() {
  if(!oled_ok) return;
  display.clearDisplay();
  display.setTextSize(1);
  display.setCursor(0,8); display.println("BLUETOOTH STATUS");
  display.drawLine(0,20,127,20,SSD1306_WHITE);
  display.setCursor(0,30); display.print("BLE: ");
  display.println(bleConnected?"CONNECTED":"NOT CONNECTED");
  display.setCursor(0,47); display.println("Waiting for app...");
  display.display();
  delay(1300);
}

// Final idle screen: only Hindi title top-left, battery top-right, tiny temp below.
// Remaining display intentionally blank; app controls/editing belongs in mobile app.
void drawIdleScreen() {
  if(!oled_ok) return;
  display.clearDisplay();

  // Factory-default layout: Hindi title top-left; battery percentage top-right.
  display.drawBitmap(titleX, titleY, hindiTitleBitmap, 56, 16, SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(batteryX, batteryY);
  if(batteryPercent>=0) { display.print(batteryPercent); display.print("%"); }
  else display.print("--%");

  display.drawLine(0,17,127,17,SSD1306_WHITE);

  // Temperature is aligned to the exact bottom-right corner.
  char tempText[12];
  if(mpu_ok) snprintf(tempText, sizeof(tempText), "%.1fC", mpu.TempC);
  else snprintf(tempText, sizeof(tempText), "--.-C");
  int dynamicTempX=128 - ((int)strlen(tempText) * 6);
  if (customLayoutEnabled) {
    display.setCursor(tempX, tempY);
  } else {
    display.setCursor(dynamicTempX, 56);
  }
  display.print(tempText);

  // Remaining OLED area intentionally stays blank.
  display.display();
}

void sendBLEData() {
  if(!dataChar) return;
  char msg[320];
  snprintf(msg,sizeof(msg),
    "{\"v\":1,\"glove\":\"right\",\"ble\":%s,\"ads_ok\":%s,\"mpu_ok\":%s,"
    "\"battery_v\":%.2f,\"battery_pin_v\":%.3f,\"battery_pct\":%d,"
    "\"pitch\":%.2f,\"roll\":%.2f,\"temp_c\":%.2f,\"flex\":[%d,%d,%d,%d,%d],"
    "\"accel\":[%d,%d,%d],\"gyro\":[%d,%d,%d]}",
    bleConnected?"true":"false",ads_ok?"true":"false",mpu_ok?"true":"false",
    batteryVoltage,batteryPinVoltage,batteryPercent,pitch,roll,mpu.TempC,
    flexRaw[0],flexRaw[1],flexRaw[2],flexRaw[3],flexRaw[4],
    mpu.AccX,mpu.AccY,mpu.AccZ,mpu.GyroX,mpu.GyroY,mpu.GyroZ);
  dataChar->setValue((uint8_t*)msg,strlen(msg));
  if(bleConnected) dataChar->notify();
}

void updateInferenceWindow() {
  // 1. Shift rolling window left by 1 frame
  for (int t = 0; t < SANKET_ROLLING_WINDOW_FRAMES - 1; t++) {
    for (int ch = 0; ch < SANKET_CHANNEL_COUNT; ch++) {
      rollingWindow[t][ch] = rollingWindow[t + 1][ch];
    }
  }

  // 2. Normalise current frame and insert at end of rolling window
  for (int i = 0; i < 5; i++) {
    rollingWindow[SANKET_ROLLING_WINDOW_FRAMES - 1][i] = normaliseFlexChannel(
      flexRaw[i],
      SANKET_CALIB_REST[i],
      SANKET_CALIB_FULLFLEX[i]
    );
  }
  rollingWindow[SANKET_ROLLING_WINDOW_FRAMES - 1][5] = (float)mpu.AccX;
  rollingWindow[SANKET_ROLLING_WINDOW_FRAMES - 1][6] = (float)mpu.AccY;
  rollingWindow[SANKET_ROLLING_WINDOW_FRAMES - 1][7] = (float)mpu.AccZ;
  rollingWindow[SANKET_ROLLING_WINDOW_FRAMES - 1][8] = (float)mpu.GyroX;
  rollingWindow[SANKET_ROLLING_WINDOW_FRAMES - 1][9] = (float)mpu.GyroY;
  rollingWindow[SANKET_ROLLING_WINDOW_FRAMES - 1][10] = (float)mpu.GyroZ;

  if (windowFrameCount < SANKET_ROLLING_WINDOW_FRAMES) {
    windowFrameCount++;
    return; // Accumulating full 5.0s window (50 frames @ 10Hz)
  }

  // 3. Resample 50-frame rolling window into 30 frames for extractFeatures99
  float resampledWindow[SANKET_WINDOW_FRAMES][SANKET_CHANNEL_COUNT];
  for (int t = 0; t < SANKET_WINDOW_FRAMES; t++) {
    float srcIdx = (float)t * (float)(SANKET_ROLLING_WINDOW_FRAMES - 1) / (float)(SANKET_WINDOW_FRAMES - 1);
    int low = (int)srcIdx;
    int high = (low < SANKET_ROLLING_WINDOW_FRAMES - 1) ? low + 1 : low;
    float alpha = srcIdx - (float)low;
    for (int ch = 0; ch < SANKET_CHANNEL_COUNT; ch++) {
      resampledWindow[t][ch] = rollingWindow[low][ch] * (1.0f - alpha) + rollingWindow[high][ch] * alpha;
    }
  }

  // 4. Extract 99 features
  float features[SANKET_FEATURE_COUNT];
  extractFeatures99(resampledWindow, features);

  // 5. Run model inference
  SanketPrediction raw = runSanketInference(features);

  // 6. Stabilise predictions (debouncing over consecutive windows)
  if (strcmp(raw.label, stablePredictionLabel) == 0) {
    stableConsecutiveCount++;
  } else {
    stablePredictionLabel[0] = '\0';
    strncat(stablePredictionLabel, raw.label, sizeof(stablePredictionLabel) - 1);
    stableConsecutiveCount = 1;
  }

  if (stableConsecutiveCount >= 2) {
    currentPrediction = raw;
  }
}

void sendBLEPrediction() {
  if (!predChar) return;
  char msg[220];
  snprintf(msg, sizeof(msg),
    "{\"v\":1,\"glove\":\"%s\",\"model_v\":\"%s\",\"label\":\"%s\",\"status\":\"%s\",\"score\":%.2f,\"margin\":%.2f}",
    SANKET_MODEL_SIDE,
    SANKET_MODEL_VERSION,
    (windowFrameCount < SANKET_ROLLING_WINDOW_FRAMES) ? "UNKNOWN" : currentPrediction.label,
    (windowFrameCount < SANKET_ROLLING_WINDOW_FRAMES) ? "warming_up" : (currentPrediction.is_valid ? "valid" : "unknown"),
    currentPrediction.score,
    currentPrediction.margin
  );
  predChar->setValue((uint8_t*)msg, strlen(msg));
  if (bleConnected) predChar->notify();
}

void setup() {
  Serial.begin(115200); delay(500);
  Serial.println("\nSANKET VAANNI RIGHT GLOVE V12 FINAL");
  layoutPrefs.begin("sv-oled", false);
  loadDisplayLayout();
  analogReadResolution(12);
  analogSetPinAttenuation(BATTERY_PIN, ADC_11db);
  pinMode(BATTERY_PIN,INPUT);
  Wire.begin(SDA_PIN,SCL_PIN); Wire.setClock(100000);

  oled_ok=display.begin(SSD1306_SWITCHCAPVCC,OLED_ADDR);
  if(oled_ok){
    // Use the OLED's normal orientation. V10's 180-degree rotation made the text upside down.
    display.setRotation(0);
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.display();
    runStartupAnimation();
  }
  else Serial.println("OLED FAIL");

  pinMode(MUX_S0,OUTPUT); pinMode(MUX_S1,OUTPUT);
  pinMode(MUX_S2,OUTPUT); pinMode(MUX_S3,OUTPUT); selectMuxChannel(0);

  if(ads.begin(ADS_ADDR)) {
    ads_ok=true; ads.setGain(GAIN_ONE); ads.setDataRate(RATE_ADS1115_128SPS);
    Serial.println("ADS1115 OK");
  } else Serial.println("ADS1115 FAIL");
  mpu_ok=initMPU(); Serial.println(mpu_ok?"MPU6050 OK":"MPU6050 FAIL");

  startBLE();
  readBattery();
  showSystemCheck();
  showBLECheck();
  pageTimer=millis();
}

void loop() {
  unsigned long now=millis();
  if(now-sensorTimer>=100) {
    sensorTimer=now;
    if(ads_ok) for(uint8_t i=0;i<5;i++) flexRaw[i]=readFlex(i);
    if(mpu_ok) {
      MPUData next=readMPU();
      if(next.AccX!=0 || next.AccY!=0 || next.AccZ!=0) { mpu=next; calculateAngles(mpu); }
    }
    updateInferenceWindow();
  }
  if(now-batteryTimer>=1000) { batteryTimer=now; readBattery(); }
  if(now-displayTimer>=500) { displayTimer=now; drawIdleScreen(); }
  if(now-bleTimer>=100) { bleTimer=now; sendBLEData(); }
  if(now-predictionTimer>=200) { predictionTimer=now; sendBLEPrediction(); }

  Serial.print("BAT_PIN_V="); Serial.print(batteryPinVoltage,3);
  Serial.print(",BAT_V="); Serial.print(batteryVoltage,2);
  Serial.print(",BAT_PCT="); Serial.print(batteryPercent);
  Serial.print(",LAYOUT="); Serial.print(customLayoutEnabled?"CUSTOM":"DEFAULT");
  Serial.print(",BLE="); Serial.print(bleConnected?"CONNECTED":"DISCONNECTED");
  Serial.print(",ADS="); Serial.print(ads_ok?"OK":"FAIL");
  Serial.print(",MPU="); Serial.print(mpu_ok?"OK":"FAIL");
  Serial.print(",TEMP="); Serial.print(mpu.TempC,1);
  Serial.print(",FLEX=");
for(int i=0;i<5;i++){ if(i) Serial.print(','); Serial.print(flexRaw[i]); }

Serial.print(",ACCEL=");
Serial.print(mpu.AccX); Serial.print(',');
Serial.print(mpu.AccY); Serial.print(',');
Serial.print(mpu.AccZ);

Serial.print(",GYRO=");
Serial.print(mpu.GyroX); Serial.print(',');
Serial.print(mpu.GyroY); Serial.print(',');
Serial.print(mpu.GyroZ);

Serial.print(",PRED="); Serial.print(currentPrediction.label);
  Serial.print(",SCORE="); Serial.print(currentPrediction.score, 2);
  Serial.println();
  delay(5);
}
