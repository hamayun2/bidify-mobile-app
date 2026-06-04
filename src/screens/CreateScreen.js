import React, { useState, useContext, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  TouchableOpacity,
  Modal,
  FlatList,
  TextInput,
  Pressable,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { AuthContext } from '../context/AuthContext';
import { createListingAPI } from '../api/listings';
import AppButton from '../components/ui/AppButton';
import SmartImage from '../components/SmartImage';
import { spacing } from '../theme';
import { AUCTION_DURATIONS } from '../constants/auctionDuration';
import {
  calculateAuctionListingFee,
  formatAuctionListingFeeMessage,
} from '../constants/auctionListingFee';
import { fetchProfileWallet } from '../services/profileWalletService';
import { isSupabaseConfigured } from '../services/supabaseClient';
import { isKycVerified, showKycBidBlockedAlert } from '../utils/kycVerification';
import { LISTING_CATEGORIES } from '../constants/listingCategories';

const SCREEN_BG = '#F4F6F8';
const INDIGO = '#1E3A8A';
const ERROR_RED = '#DC2626';

/** Major Pakistani cities — static list for OLX-style location picker (no API). */
const PAKISTANI_CITIES = [
  'Karachi',
  'Lahore',
  'Islamabad',
  'Rawalpindi',
  'Faisalabad',
  'Multan',
  'Bahawalpur',
  'Chichawatni',
  'Peshawar',
  'Quetta',
  'Sialkot',
  'Gujranwala',
  'Hyderabad',
  'Abbottabad',
  'Sargodha',
  'Sukkur',
  'Larkana',
  'Mardan',
  'Gujrat',
  'Sheikhupura',
];

const DURATIONS = AUCTION_DURATIONS;

const LISTING_KINDS = [
  {
    key: 'standard',
    label: 'Standard',
    icon: 'storefront-outline',
    hint: 'Direct sale. Buyer chats with you to coordinate the deal.',
  },
  {
    key: 'auction',
    label: 'Auction',
    icon: 'hammer-outline',
    hint: 'Bidding with timing & automated payment for the winning bid.',
  },
];

const FORM_ERROR_DEFAULT =
  'Please fill in all mandatory fields, including Location and Photos.';

function SuccessModal({ visible, onClose }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalOverlay} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
          <Ionicons name="checkmark-circle" size={56} color="#16A34A" />
          <Text style={styles.modalTitle}>Success!</Text>
          <Text style={styles.modalMessage}>Your listing has been published successfully.</Text>
          <TouchableOpacity style={styles.modalOkBtn} onPress={onClose} activeOpacity={0.88}>
            <Text style={styles.modalOkText}>OK</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function FieldLabel({ children }) {
  return <Text style={styles.label}>{children}</Text>;
}

function PremiumInput({
  value,
  onChangeText,
  placeholder,
  multiline,
  keyboardType,
  hasError,
  onFocus,
}) {
  return (
    <TextInput
      style={[
        styles.input,
        multiline && styles.inputMultiline,
        hasError && styles.inputError,
      ]}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor="#94A3B8"
      multiline={multiline}
      numberOfLines={multiline ? 4 : 1}
      keyboardType={keyboardType}
      autoCapitalize="sentences"
      onFocus={onFocus}
    />
  );
}

const CreateScreen = ({ navigation }) => {
  const { user, lockSession, refreshProfile } = useContext(AuthContext);
  const submittingRef = useRef(false);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [category, setCategory] = useState('');
  const [listingKind, setListingKind] = useState('standard');
  const [standardPrice, setStandardPrice] = useState('');
  const [startingBid, setStartingBid] = useState('');
  const [buyNowPrice, setBuyNowPrice] = useState('');
  const [duration, setDuration] = useState('3');
  const [images, setImages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);
  const [durationOpen, setDurationOpen] = useState(false);
  const [formTouched, setFormTouched] = useState(false);
  const [formError, setFormError] = useState('');
  const [successVisible, setSuccessVisible] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [modalTitle, setModalTitle] = useState('');
  const [modalMessage, setModalMessage] = useState('');

  const isAuction = listingKind === 'auction';
  const activeKindHint = LISTING_KINDS.find((k) => k.key === listingKind)?.hint;

  const parsedStartingBid = useMemo(() => {
    const n = parseInt(String(startingBid || '').replace(/\D/g, ''), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [startingBid]);

  const auctionListingFee = useMemo(() => {
    if (!isAuction || parsedStartingBid <= 0) return 0;
    return calculateAuctionListingFee(parsedStartingBid);
  }, [isAuction, parsedStartingBid]);

  const fieldErrors = useCallback(() => {
    if (!formTouched) return {};
    const priceStr = isAuction ? startingBid : standardPrice;
    const priceValue = parseInt(priceStr, 10);
    const priceOk = Number.isFinite(priceValue) && priceValue > 0 && priceValue % 100 === 0;
    return {
      photos: images.length < 2,
      title: !title.trim(),
      description: !description.trim(),
      location: !location.trim(),
      category: !category,
      listingKind: !listingKind,
      price: !priceOk,
    };
  }, [
    formTouched,
    images.length,
    title,
    description,
    location,
    category,
    listingKind,
    isAuction,
    startingBid,
    standardPrice,
  ]);

  const errors = fieldErrors();

  const showModal = (t, m) => {
    setModalTitle(t);
    setModalMessage(m);
    setModalVisible(true);
  };

  const clearForm = () => {
    setTitle('');
    setDescription('');
    setLocation('');
    setCategory('');
    setListingKind('standard');
    setStandardPrice('');
    setStartingBid('');
    setBuyNowPrice('');
    setDuration('3');
    setImages([]);
    setFormTouched(false);
    setFormError('');
  };

  const validateBeforeSubmit = () => {
    const priceStr = isAuction ? startingBid : standardPrice;
    const priceValue = parseInt(priceStr, 10);
    const priceOk = Number.isFinite(priceValue) && priceValue > 0 && priceValue % 100 === 0;

    const missing =
      images.length < 2 ||
      !title.trim() ||
      !description.trim() ||
      !location.trim() ||
      !category ||
      !listingKind ||
      !priceOk;

    if (missing) {
      setFormTouched(true);
      setFormError(FORM_ERROR_DEFAULT);
      return false;
    }

    setFormError('');
    return true;
  };

  const pickImage = async () => {
    if (images.length >= 8) {
      showModal('Limit reached', 'You can upload a maximum of 8 pictures.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
      quality: 1,
      exif: false,
    });
    if (!result.canceled) {
      setImages((prev) => [...prev, result.assets[0].uri]);
      if (formError) setFormError('');
    }
  };

  const removeImage = (index) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSuccessDismiss = () => {
    setSuccessVisible(false);
    clearForm();
    try {
      navigation.navigate('MainTabs', { screen: 'Home' });
    } catch (_) {
      try {
        navigation.navigate('MainTabs', { screen: 'Home' });
      } catch (__) {
        /* stay on Sell tab */
      }
    }
  };

  const handleSubmit = () => {
    if (!validateBeforeSubmit()) return;
    if (!isKycVerified(user)) {
      showKycBidBlockedAlert();
      return;
    }
    if (submittingRef.current || loading) return;
    void executePublishListing();
  };

  const executePublishListing = async () => {
    if (submittingRef.current || loading) return;

    const priceStr = isAuction ? startingBid : standardPrice;
    const priceValue = parseInt(priceStr, 10);

    submittingRef.current = true;
    setLoading(true);

    const liveUid = user?.id || user?.uid || null;
    if (!liveUid) {
      submittingRef.current = false;
      setLoading(false);
      showModal(
        'Not signed in',
        'User not authenticated. Please log out and log in again before publishing.'
      );
      return;
    }

    if (isAuction && auctionListingFee > 0 && isSupabaseConfigured()) {
      try {
        const pw = await fetchProfileWallet(liveUid);
        if (pw.walletBalance < auctionListingFee) {
          submittingRef.current = false;
          setLoading(false);
          Alert.alert('Insufficient balance', formatAuctionListingFeeMessage(auctionListingFee));
          return;
        }
      } catch (walletErr) {
        submittingRef.current = false;
        setLoading(false);
        Alert.alert(
          'Wallet check failed',
          walletErr?.message || 'Could not verify your wallet balance. Please try again.'
        );
        return;
      }
    }

    const releaseLock = typeof lockSession === 'function' ? lockSession() : () => {};
    let watchdog;
    let watchdogFired = false;
    const armWatchdog = () => {
      watchdog = setTimeout(() => {
        watchdogFired = true;
        submittingRef.current = false;
        setLoading(false);
        try {
          releaseLock();
        } catch (_) {}
        showModal(
          'Taking too long',
          'The listing is taking unusually long to publish. Check your internet and try again.'
        );
      }, 130000);
    };
    const disarmWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
    };

    armWatchdog();
    try {
      const publishResult = await createListingAPI({
        title: title.trim(),
        description: description.trim(),
        location: location.trim(),
        price: priceValue,
        type: isAuction ? 'auction' : 'standard',
        category,
        buyNowPrice: isAuction && buyNowPrice ? parseInt(buyNowPrice, 10) : undefined,
        duration: isAuction ? duration : null,
        images,
        userId: liveUid,
        sellerId: liveUid,
        userEmail: user?.email || null,
        username: user?.username || null,
        fullName: user?.fullName || user?.name || null,
      });

      const publishedId =
        publishResult?.listingId ??
        publishResult?.listing?.id ??
        publishResult?.listing?._id ??
        null;
      if (!publishedId) {
        throw new Error(
          'Listing was not confirmed by the server. Please wait a moment and check Home before publishing again.'
        );
      }

      if (!watchdogFired) {
        setSuccessVisible(true);
      } else {
        clearForm();
      }
    } catch (error) {
      const msg =
        (error && (error.message || error?.toString?.())) || 'Failed to create listing.';
      if (!watchdogFired) showModal('Error creating listing', msg);
      try {
        await refreshProfile?.();
      } catch (_) {}
    } finally {
      disarmWatchdog();
      releaseLock();
      submittingRef.current = false;
      setLoading(false);
    }
  };

  const renderDropdown = (value, placeholder, onOpen, hasError) => (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onOpen}
      style={[styles.dropdown, hasError && styles.inputError]}
    >
      <Text style={[styles.dropdownValue, !value && styles.dropdownPlaceholder]}>
        {value || placeholder}
      </Text>
      <Ionicons name="chevron-down" size={18} color="#94A3B8" />
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.headerBlock}>
            <Text style={styles.headerTitle}>Create Listing</Text>
            <Text style={styles.headerSubtitle}>Showcase your item to collectors worldwide.</Text>
          </View>

          <View style={styles.formCard}>
            <Text style={styles.cardTitle}>Item Details</Text>

            <FieldLabel>Photos</FieldLabel>
            <TouchableOpacity
              style={[styles.uploadBox, errors.photos && styles.inputError]}
              onPress={pickImage}
              activeOpacity={0.88}
            >
              <View style={styles.uploadIconCircle}>
                <Ionicons name="cloud-upload-outline" size={32} color={INDIGO} />
              </View>
              <Text style={styles.uploadTitle}>Upload Photos</Text>
              <Text style={styles.uploadHint}>
                Tap to add images · At least 2 required (max 8)
              </Text>
            </TouchableOpacity>

            {images.length > 0 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.thumbRow}
              >
                {images.map((uri, i) => (
                  <View key={`${uri}-${i}`} style={styles.thumbWrap}>
                    <SmartImage uri={uri} style={styles.thumb} resizeMode="cover" showLoader={false} />
                    <TouchableOpacity style={styles.thumbRemove} onPress={() => removeImage(i)}>
                      <Ionicons name="close" size={14} color="#FFFFFF" />
                    </TouchableOpacity>
                  </View>
                ))}
              </ScrollView>
            ) : null}

            <FieldLabel>Title</FieldLabel>
            <PremiumInput
              placeholder="e.g. Antique Persian Vase"
              value={title}
              onChangeText={(t) => {
                setTitle(t);
                if (formError) setFormError('');
              }}
              hasError={errors.title}
            />

            <FieldLabel>Description</FieldLabel>
            <PremiumInput
              placeholder="Describe your item in detail…"
              value={description}
              onChangeText={(t) => {
                setDescription(t);
                if (formError) setFormError('');
              }}
              multiline
              hasError={errors.description}
            />

            <FieldLabel>Location</FieldLabel>
            {renderDropdown(
              location,
              'Select City...',
              () => setLocationOpen(true),
              errors.location
            )}

            <FieldLabel>Category</FieldLabel>
            {renderDropdown(category, 'Select category', () => setCategoryOpen(true), errors.category)}
          </View>

          <View style={styles.formCard}>
            <Text style={styles.cardTitle}>Listing Type</Text>
            <View style={styles.typeGrid}>
              {LISTING_KINDS.map((t) => {
                const active = listingKind === t.key;
                return (
                  <TouchableOpacity
                    key={t.key}
                    style={[styles.typeCell, active && styles.typeCellActive]}
                    onPress={() => {
                      setListingKind(t.key);
                      if (formError) setFormError('');
                    }}
                    activeOpacity={0.88}
                  >
                    <Ionicons name={t.icon} size={22} color={active ? INDIGO : '#64748B'} />
                    <Text style={[styles.typeLabel, active && styles.typeLabelActive]}>{t.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            {activeKindHint ? <Text style={styles.typeHint}>{activeKindHint}</Text> : null}

            {isAuction ? (
              <>
                <FieldLabel>Starting Bid (Rs)</FieldLabel>
                <PremiumInput
                  placeholder="e.g. 5000"
                  keyboardType="numeric"
                  value={startingBid}
                  onChangeText={(t) => {
                    setStartingBid(t.replace(/\D/g, ''));
                    if (formError) setFormError('');
                  }}
                  hasError={errors.price}
                />
                {parsedStartingBid > 0 ? (
                  <View style={styles.auctionFeeBox}>
                    <Ionicons name="information-circle-outline" size={18} color={INDIGO} />
                    <Text style={styles.auctionFeeText}>
                      Auction listing activation fee:{' '}
                      <Text style={styles.auctionFeeAmount}>
                        Rs. {auctionListingFee.toLocaleString()}
                      </Text>
                      {'\n'}
                      Rs. 500 held from your wallet when you publish (refunded if you delete
                      before the auction ends). Standard listings remain free.
                    </Text>
                  </View>
                ) : null}
                <FieldLabel>Buy Now Price (Rs)</FieldLabel>
                <PremiumInput
                  placeholder="Optional"
                  keyboardType="numeric"
                  value={buyNowPrice}
                  onChangeText={(t) => setBuyNowPrice(t.replace(/\D/g, ''))}
                />
                <FieldLabel>Duration</FieldLabel>
                {renderDropdown(
                  DURATIONS.find((d) => d.value === duration)?.label,
                  'Select duration',
                  () => setDurationOpen(true),
                  false
                )}
              </>
            ) : (
              <>
                <FieldLabel>Price (Rs)</FieldLabel>
                <PremiumInput
                  placeholder="e.g. 5000"
                  keyboardType="numeric"
                  value={standardPrice}
                  onChangeText={(t) => {
                    setStandardPrice(t.replace(/\D/g, ''));
                    if (formError) setFormError('');
                  }}
                  hasError={errors.price}
                />
                <Text style={styles.helperText}>
                  Buyers will reach out via Chat with Seller to arrange the deal.
                </Text>
              </>
            )}
          </View>

          {formError ? <Text style={styles.formErrorText}>{formError}</Text> : null}

          <AppButton
            title="Publish Listing"
            loading={loading}
            onPress={handleSubmit}
            style={styles.submit}
          />

          <View style={{ height: 48 }} />
        </ScrollView>
      </KeyboardAvoidingView>

      <Modal
        visible={locationOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setLocationOpen(false)}
      >
        <View style={styles.sheetContainer}>
          <Pressable style={styles.sheetBackdrop} onPress={() => setLocationOpen(false)} />
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeaderRow}>
              <View style={styles.sheetHeaderIcon}>
                <Ionicons name="location-outline" size={22} color={INDIGO} />
              </View>
              <View style={styles.sheetHeaderTextCol}>
                <Text style={styles.sheetTitle}>Select City</Text>
                <Text style={styles.sheetSubtitle}>Choose where your item is located</Text>
              </View>
              <TouchableOpacity
                onPress={() => setLocationOpen(false)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons name="close" size={24} color="#94A3B8" />
              </TouchableOpacity>
            </View>
            <FlatList
              data={PAKISTANI_CITIES}
              keyExtractor={(item) => item}
              showsVerticalScrollIndicator
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.sheetRow}
                  onPress={() => {
                    setLocation(item);
                    setLocationOpen(false);
                    if (formError) setFormError('');
                  }}
                  activeOpacity={0.75}
                >
                  <Text style={styles.sheetRowText}>{item}</Text>
                  {location === item ? (
                    <Ionicons name="checkmark-circle" size={22} color={INDIGO} />
                  ) : null}
                </TouchableOpacity>
              )}
            />
          </View>
        </View>
      </Modal>

      <Modal visible={categoryOpen} transparent animationType="fade" onRequestClose={() => setCategoryOpen(false)}>
        <View style={styles.sheetContainer}>
          <Pressable style={styles.sheetBackdrop} onPress={() => setCategoryOpen(false)} />
          <View style={styles.sheet}>
          <Text style={styles.sheetTitle}>Select category</Text>
          <FlatList
            data={LISTING_CATEGORIES}
            keyExtractor={(i) => i}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.sheetRow}
                onPress={() => {
                  setCategory(item);
                  setCategoryOpen(false);
                  if (formError) setFormError('');
                }}
              >
                <Text style={styles.sheetRowText}>{item}</Text>
                {category === item ? <Ionicons name="checkmark" size={20} color={INDIGO} /> : null}
              </TouchableOpacity>
            )}
          />
          </View>
        </View>
      </Modal>

      <Modal visible={durationOpen} transparent animationType="fade" onRequestClose={() => setDurationOpen(false)}>
        <View style={styles.sheetContainer}>
          <Pressable style={styles.sheetBackdrop} onPress={() => setDurationOpen(false)} />
          <View style={styles.sheet}>
          <Text style={styles.sheetTitle}>Select duration</Text>
          {DURATIONS.map((d) => (
            <TouchableOpacity
              key={d.value}
              style={styles.sheetRow}
              onPress={() => {
                setDuration(d.value);
                setDurationOpen(false);
              }}
            >
              <Text style={styles.sheetRowText}>{d.label}</Text>
              {duration === d.value ? <Ionicons name="checkmark" size={20} color={INDIGO} /> : null}
            </TouchableOpacity>
          ))}
          </View>
        </View>
      </Modal>

      <Modal visible={modalVisible} transparent animationType="fade" onRequestClose={() => setModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitleError}>{modalTitle}</Text>
            <Text style={styles.modalMessage}>{modalMessage}</Text>
            <TouchableOpacity style={styles.modalOkBtn} onPress={() => setModalVisible(false)}>
              <Text style={styles.modalOkText}>OK</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <SuccessModal visible={successVisible} onClose={handleSuccessDismiss} />
    </SafeAreaView>
  );
};

const cardShadow = Platform.select({
  ios: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
  },
  android: { elevation: 2 },
});

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: SCREEN_BG },
  flex: { flex: 1 },
  scroll: { padding: spacing.xl, paddingBottom: spacing.xxxl },
  headerBlock: { marginBottom: spacing.lg },
  headerTitle: {
    fontSize: 28,
    fontWeight: '800',
    color: '#0F172A',
    letterSpacing: -0.5,
  },
  headerSubtitle: {
    fontSize: 14,
    color: '#64748B',
    marginTop: 4,
    fontWeight: '500',
  },
  formCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    ...cardShadow,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0F172A',
    marginBottom: spacing.md,
    letterSpacing: -0.2,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: '#475569',
    marginBottom: 8,
    marginTop: spacing.md,
  },
  uploadBox: {
    backgroundColor: '#FAFAFA',
    borderWidth: 1.5,
    borderColor: '#CBD5E1',
    borderStyle: 'dashed',
    borderRadius: 12,
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
  },
  uploadIconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#EEF2FF',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  uploadTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0F172A',
  },
  uploadHint: {
    fontSize: 13,
    color: '#64748B',
    marginTop: 4,
    textAlign: 'center',
    lineHeight: 18,
  },
  thumbRow: { paddingVertical: spacing.md, gap: spacing.sm },
  thumbWrap: {
    width: 80,
    height: 80,
    borderRadius: 10,
    overflow: 'hidden',
    marginRight: spacing.sm,
    position: 'relative',
    backgroundColor: '#EDE9E3',
  },
  thumb: { width: '100%', height: '100%' },
  thumbRemove: {
    position: 'absolute',
    top: 4,
    right: 4,
    backgroundColor: 'rgba(0,0,0,0.65)',
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 8,
    backgroundColor: '#FAFAFA',
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'ios' ? 14 : 12,
    fontSize: 15,
    fontWeight: '500',
    color: '#0F172A',
  },
  inputMultiline: {
    minHeight: 110,
    textAlignVertical: 'top',
  },
  inputError: {
    borderColor: ERROR_RED,
    backgroundColor: '#FEF2F2',
  },
  dropdown: {
    backgroundColor: '#FAFAFA',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingHorizontal: spacing.md,
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dropdownValue: { fontSize: 15, color: '#0F172A', fontWeight: '600' },
  dropdownPlaceholder: { color: '#94A3B8', fontWeight: '500' },
  typeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  typeCell: {
    width: '48%',
    paddingVertical: spacing.lg,
    borderRadius: 12,
    backgroundColor: '#FAFAFA',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    alignItems: 'center',
    gap: 6,
  },
  typeCellActive: {
    backgroundColor: '#EEF2FF',
    borderColor: INDIGO,
  },
  typeLabel: { fontSize: 14, fontWeight: '700', color: '#64748B' },
  typeLabelActive: { color: INDIGO },
  typeHint: {
    fontSize: 13,
    marginTop: spacing.sm,
    color: '#64748B',
    lineHeight: 18,
  },
  auctionFeeBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
    padding: 12,
    borderRadius: 10,
    backgroundColor: '#EFF6FF',
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  auctionFeeText: {
    flex: 1,
    fontSize: 12,
    color: '#475569',
    lineHeight: 17,
  },
  auctionFeeAmount: {
    fontWeight: '800',
    color: INDIGO,
  },
  helperText: {
    fontSize: 13,
    marginTop: spacing.sm,
    color: '#64748B',
    lineHeight: 18,
  },
  formErrorText: {
    fontSize: 14,
    fontWeight: '600',
    color: ERROR_RED,
    textAlign: 'center',
    marginBottom: spacing.md,
    lineHeight: 20,
  },
  submit: { marginTop: spacing.sm },
  sheetContainer: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheetBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xxl,
    maxHeight: '70%',
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#CBD5E1',
    marginBottom: spacing.md,
  },
  sheetHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.md,
    gap: spacing.md,
  },
  sheetHeaderIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: '#EEF2FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetHeaderTextCol: { flex: 1 },
  sheetTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0F172A',
  },
  sheetSubtitle: {
    fontSize: 13,
    color: '#64748B',
    marginTop: 2,
  },
  sheetRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E2E8F0',
  },
  sheetRowText: { fontSize: 15, color: '#0F172A', fontWeight: '500' },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  modalCard: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    ...cardShadow,
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: '#0F172A',
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  modalTitleError: {
    fontSize: 18,
    fontWeight: '800',
    color: ERROR_RED,
    marginBottom: spacing.sm,
    alignSelf: 'flex-start',
  },
  modalMessage: {
    fontSize: 15,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: spacing.lg,
  },
  modalOkBtn: {
    width: '100%',
    backgroundColor: INDIGO,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  modalOkText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
  },
});

export default CreateScreen;
