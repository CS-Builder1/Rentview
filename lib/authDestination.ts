import AsyncStorage from "@react-native-async-storage/async-storage";
import { createAuthDestinationStore } from "./authDestinationStore";

const store=createAuthDestinationStore(AsyncStorage);
export const rememberAuthDestination=store.remember;
export const pendingAuthDestination=store.pending;
export const clearAuthDestination=store.clear;
