import React, { useState } from 'react';
import { View, TextInput, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing } from '../../theme';

/**
 * Rounded, light-gray text input with optional leading icon and password eye toggle.
 */
const AppInput = ({
  value,
  onChangeText,
  placeholder,
  keyboardType,
  autoCapitalize = 'none',
  secureTextEntry = false,
  iconName,
  multiline = false,
  numberOfLines,
  style,
  inputStyle,
  editable = true,
  maxLength,
  onBlur,
  onFocus,
  returnKeyType,
  textAlignVertical,
}) => {
  const [hidden, setHidden] = useState(secureTextEntry);
  const showEye = secureTextEntry;

  return (
    <View style={[styles.wrap, multiline && styles.wrapMultiline, style]}>
      {iconName ? (
        <Ionicons name={iconName} size={18} color={colors.textMuted} style={styles.leadingIcon} />
      ) : null}
      <TextInput
        style={[
          styles.input,
          iconName ? styles.inputWithIcon : null,
          multiline ? styles.inputMultiline : null,
          inputStyle,
        ]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        secureTextEntry={hidden}
        multiline={multiline}
        numberOfLines={numberOfLines}
        editable={editable}
        maxLength={maxLength}
        onBlur={onBlur}
        onFocus={onFocus}
        returnKeyType={returnKeyType}
        textAlignVertical={textAlignVertical || (multiline ? 'top' : 'center')}
      />
      {showEye ? (
        <TouchableOpacity onPress={() => setHidden((h) => !h)} style={styles.eye}>
          <Ionicons
            name={hidden ? 'eye-off-outline' : 'eye-outline'}
            size={18}
            color={colors.textMuted}
          />
        </TouchableOpacity>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    minHeight: 52,
  },
  wrapMultiline: {
    alignItems: 'flex-start',
    paddingVertical: spacing.sm,
    minHeight: 110,
  },
  leadingIcon: {
    marginRight: spacing.sm,
  },
  input: {
    flex: 1,
    fontSize: 15,
    color: colors.text,
    paddingVertical: 0,
  },
  inputWithIcon: {
    marginLeft: 0,
  },
  inputMultiline: {
    minHeight: 92,
    paddingTop: 4,
  },
  eye: {
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
});

export default AppInput;
